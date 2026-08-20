#!/usr/bin/env node
"use strict";

/**
 * SAS EuroBonus award scanner.
 *
 *   node search.js login      one-time manual login, saves the session
 *   node search.js capture    record a real search; learn the request that returns prices
 *   node search.js pull       replay that request across routes/dates into a local database
 *   node search.js query      look up the pulled data offline, any way you like
 *   node search.js report     build the HTML calendar report from the database
 *   node search.js scan       fallback: drive the UI page-by-page instead of replaying
 *
 * See README.md.
 */

// node:sqlite is stable enough for this use but still emits an experimental
// warning on every run; keep it out of the tool's output without hiding others.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (!/SQLite is an experimental feature/.test(w.message)) console.warn(w.stack || String(w));
});

const fs = require("fs");
const path = require("path");

const plan = require("./lib/plan.js");
const report = require("./lib/report.js");
const replayLib = require("./lib/replay.js");
const { Store } = require("./lib/store.js");

const ROOT = __dirname;
const CONFIG_PATH = process.env.SAS_CONFIG || path.join(ROOT, "config.json");
const OUT_DIR = path.join(ROOT, "out");
const STATE_PATH = path.join(ROOT, ".session.json");
const DB_PATH = process.env.SAS_DB || path.join(OUT_DIR, "awards.db");
const RECIPES_PATH = path.join(OUT_DIR, "recipes.json");
const HTML_PATH = path.join(OUT_DIR, "report.html");
const CAPTURE_DIR = path.join(OUT_DIR, "captured");
const LEGACY_RESULTS = path.join(OUT_DIR, "offers.json");

const DEFAULT_START_URL = "https://www.flysas.com/en/";

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No config at ${CONFIG_PATH}.\nCopy config.example.json to config.json and edit it.`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!cfg.dates || !cfg.dates.from || !cfg.dates.to) {
    throw new Error("config.dates.from and config.dates.to are required (YYYY-MM-DD).");
  }
  return cfg;
}

function loadRecipes() {
  if (!fs.existsSync(RECIPES_PATH)) {
    throw new Error(`No recipes at ${RECIPES_PATH} — run \`node search.js capture\` first.`);
  }
  const data = JSON.parse(fs.readFileSync(RECIPES_PATH, "utf8"));
  if (!data.recipes || !data.recipes.length) {
    throw new Error("recipes.json has no recipes — re-run `capture` and make sure prices were on screen.");
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Requests are sequential with jittered delays. This is a personal search tool;
 * it should look like a person searching. Replay makes each request cheap, which
 * is a reason to pull a wider net, not to pull it faster.
 */
function throttleDelay(cfg) {
  const min = cfg.throttle?.minMs ?? 4000;
  const max = cfg.throttle?.maxMs ?? 9000;
  return min + Math.random() * Math.max(0, max - min);
}

/* ------------------------------------------------------------------ login */

async function cmdLogin() {
  const { login } = require("./lib/browser.js");
  const cfg = fs.existsSync(CONFIG_PATH) ? loadConfig() : {};
  await login({ startUrl: cfg.startUrl || DEFAULT_START_URL, storageStatePath: STATE_PATH });
}

/* ---------------------------------------------------------------- capture */

async function cmdCapture() {
  const { capture } = require("./lib/browser.js");
  const cfg = fs.existsSync(CONFIG_PATH) ? loadConfig() : {};
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await capture({
    startUrl: cfg.startUrl || DEFAULT_START_URL,
    storageStatePath: STATE_PATH,
    outDir: CAPTURE_DIR,
  });
}

/* ------------------------------------------------------------------- pull */

/** Distinct YYYY-MM months touched by a date range. */
function monthsBetween(from, to) {
  const out = [];
  const start = plan.parseISO(from);
  const end = plan.parseISO(to);
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (d <= end) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Turn the config into the smallest set of requests that covers it, given how
 * finely the chosen recipe has to be addressed.
 */
function buildPullTasks(cfg, granularity) {
  const origins = [].concat(cfg.origins || []);
  const destinations = [].concat(cfg.destinations || []);
  if (!origins.length || !destinations.length) throw new Error("config.origins and config.destinations are required");

  if (granularity === "day") return plan.buildPlan(cfg).tasks;

  const anchors = granularity === "month"
    ? monthsBetween(cfg.dates.from, cfg.dates.to)
    : [cfg.dates.from];

  const tasks = [];
  for (const origin of origins) {
    for (const destination of destinations) {
      if (origin === destination) continue;
      for (const date of anchors) {
        tasks.push({
          origin, destination, date,
          returnDate: cfg.tripLengthDays
            ? plan.toISO(new Date(plan.parseISO(date).getTime() + cfg.tripLengthDays * 86400000))
            : null,
          adults: cfg.adults || 1,
        });
      }
    }
  }
  return tasks;
}

async function cmdPull(argv) {
  const cfg = loadConfig();
  const { recipes } = loadRecipes();
  const idx = Number(argv.recipe ?? 0);
  const recipe = recipes[idx];
  if (!recipe) throw new Error(`No recipe [${idx}] — recipes.json has ${recipes.length}.`);

  const granularity = replayLib.dateGranularity(recipe);
  const tasks = buildPullTasks(cfg, granularity);
  const limited = argv.limit ? tasks.slice(0, Number(argv.limit)) : tasks;

  const perRequest = { day: "one date", month: "one month", none: "the endpoint's own window" };
  console.log(`Recipe [${idx}] ${recipe.name}`);
  console.log(`  each request covers ${perRequest[granularity]} — ${limited.length} request(s) to run`);
  if (granularity === "day") {
    console.log("  (no calendar-style request was captured; re-run `capture` using the site's");
    console.log("   flexible-date view if it has one, to cover far more dates per request)");
  }

  const { launch } = require("./lib/browser.js");
  const { browser, context } = await launch({ headless: true, storageState: STATE_PATH });
  const store = new Store(DB_PATH);

  let totalStored = 0, emptyStreak = 0, datelessWarned = false;
  try {
    for (let i = 0; i < limited.length; i++) {
      const t = limited[i];
      process.stdout.write(`[${String(i + 1).padStart(4)}/${limited.length}] ${t.origin}->${t.destination} ${t.date} ... `);

      let res;
      try {
        res = await replayLib.replay(context.request, recipe, t, { timeout: cfg.waitMs ?? 30000 });
      } catch (e) {
        console.log(`error: ${e.message.split("\n")[0]}`);
        continue;
      }

      if (!res.json) {
        console.log(`HTTP ${res.status}, no JSON (session may have expired)`);
        emptyStreak++;
        if (emptyStreak === 3) {
          console.log("\n  Three non-JSON responses in a row — re-run `node search.js login`.\n");
        }
        await sleep(throttleDelay(cfg));
        continue;
      }

      const { harvest, dedupe } = require("./lib/harvest.js");
      const offers = dedupe(harvest(res.json, { source: recipe.name }));

      // A window/month recipe must supply its own dates; falling back to the
      // anchor would silently stack a whole month onto one day.
      const dateless = offers.filter((o) => !o.date);
      if (granularity !== "day" && dateless.length && !datelessWarned) {
        console.log("");
        console.log("  Warning: this response carried prices without dates. They are being");
        console.log("  dropped rather than guessed. Inspect out/captured/ and extend the");
        console.log("  date matcher in lib/harvest.js if these matter.");
        datelessWarned = true;
        process.stdout.write("            ... ");
      }

      const usable = [];
      for (const o of offers) {
        o.origin = o.origin || t.origin;
        o.destination = o.destination || t.destination;
        if (!o.date && granularity === "day") o.date = t.date;
        o.cabinNorm = plan.normalizeCabin(o.cabin);
        if (o.date) usable.push(o);
      }

      const { stored } = store.upsertOffers(usable);
      totalStored += stored;
      store.recordSearch({
        origin: t.origin, destination: t.destination,
        from: t.date, to: t.date, recipe: recipe.name, offersFound: stored,
      });
      const dates = new Set(usable.map((o) => o.date)).size;
      console.log(`${stored} price(s) across ${dates} date(s)`);

      emptyStreak = stored ? 0 : emptyStreak + 1;
      if (i < limited.length - 1) await sleep(throttleDelay(cfg));
    }
  } finally {
    await browser.close();
    const s = store.stats();
    console.log(`\nStored ${totalStored} price(s) this run.`);
    console.log(`Database: ${DB_PATH}`);
    console.log(`  ${s.offers} offers across ${s.routes} route(s), ` +
      `${s.dateRange.lo || "-"} to ${s.dateRange.hi || "-"}`);
    store.close();
  }
  console.log(`\nNow query it, e.g.:\n  node search.js query --cheapest\n  node search.js query --cabin=business --saver\n`);
}

/* ------------------------------------------------------------------ query */

function openStore() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`No database at ${DB_PATH} — run \`node search.js pull\` first.`);
  }
  return new Store(DB_PATH);
}

function table(rows, columns) {
  if (!rows.length) { console.log("  (nothing matched)"); return; }
  const widths = columns.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? "").length)));
  console.log("  " + columns.map((c, i) =>
    (c.right ? c.label.padStart(widths[i]) : c.label.padEnd(widths[i]))).join("  "));
  for (const r of rows) {
    console.log("  " + columns.map((c, i) => {
      const v = String(c.get(r) ?? "");
      return c.right ? v.padStart(widths[i]) : v.padEnd(widths[i]);
    }).join("  "));
  }
}

const num = (n) => (n === null || n === undefined ? "" : Number(n).toLocaleString("en-GB"));

function cmdQuery(argv) {
  const store = openStore();
  try {
    if (argv.stats) {
      const s = store.stats();
      console.log("\nDatabase:", DB_PATH);
      console.log(`  offers        ${s.offers}`);
      console.log(`  observations  ${s.observations}`);
      console.log(`  searches      ${s.searches}`);
      console.log(`  routes        ${s.routes}`);
      console.log(`  dates         ${s.dateRange.lo || "-"} .. ${s.dateRange.hi || "-"}`);
      console.log(`  last pull     ${s.lastPull || "-"}\n`);
      return;
    }

    if (argv.changes) {
      console.log("\nPrices that moved between pulls:\n");
      table(store.priceChanges({ limit: Number(argv.limit) || 30 }), [
        { label: "ROUTE", get: (r) => `${r.origin}-${r.destination}` },
        { label: "DATE", get: (r) => r.depart_date },
        { label: "CABIN", get: (r) => r.cabin },
        { label: "LOW", get: (r) => num(r.low), right: true },
        { label: "HIGH", get: (r) => num(r.high), right: true },
        { label: "SWING", get: (r) => num(r.high - r.low), right: true },
      ]);
      console.log("");
      return;
    }

    if (argv.cheapest) {
      const rows = store.cheapestPerDestination({
        origin: argv.origin, cabin: argv.cabin,
        from: argv.from, to: argv.to, limit: Number(argv.limit) || 100,
      });
      console.log("\nCheapest points price per destination:\n");
      table(rows, [
        { label: "DEST", get: (r) => r.destination },
        { label: "CABIN", get: (r) => r.cabin },
        { label: "POINTS", get: (r) => num(r.points), right: true },
        { label: "DATES", get: (r) => r.dates_available, right: true },
        { label: "FROM", get: (r) => r.earliest },
        { label: "TO", get: (r) => r.latest },
      ]);
      console.log("");
      return;
    }

    const weekdays = argv.weekdays
      ? String(argv.weekdays).split(",").map((n) => Number(n.trim())).filter((n) => !Number.isNaN(n))
      : null;

    const rows = store.query({
      origin: argv.origin, destination: argv.destination, cabin: argv.cabin,
      maxPoints: argv["max-points"], minPoints: argv["min-points"],
      from: argv.from, to: argv.to, weekdays,
      maxCash: argv["max-cash"], minSeats: argv["min-seats"],
      saverOnly: !!argv.saver, order: argv.order || "points",
      limit: Number(argv.limit) || 40,
    });

    console.log(`\n${rows.length} match(es):\n`);
    table(rows, [
      { label: "DATE", get: (r) => r.depart_date },
      { label: "DAY", get: (r) => report.weekdayOf(r.depart_date) },
      { label: "ROUTE", get: (r) => `${r.origin}-${r.destination}` },
      { label: "CABIN", get: (r) => r.cabin },
      { label: "POINTS", get: (r) => num(r.points), right: true },
      { label: "TAXES", get: (r) => (r.cash === null ? "" : `${num(Math.round(r.cash))} ${r.currency || ""}`), right: true },
      { label: "SEATS", get: (r) => (r.seats === null ? "" : r.seats), right: true },
    ]);

    if (argv.csv) {
      const file = typeof argv.csv === "string" ? argv.csv : path.join(OUT_DIR, "query.csv");
      const header = "date,origin,destination,cabin,points,cash,currency,seats\n";
      const body = rows.map((r) => [r.depart_date, r.origin, r.destination, r.cabin,
        r.points, r.cash ?? "", r.currency ?? "", r.seats ?? ""].join(",")).join("\n");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, header + body + "\n");
      console.log(`\nCSV: ${file}`);
    }
    console.log("");
  } finally {
    store.close();
  }
}

/* ----------------------------------------------------------------- report */

function offersFromDb(store) {
  return store.allOffers().map((r) => ({
    origin: r.origin, destination: r.destination, date: r.depart_date,
    cabin: r.cabin, points: r.points, cash: r.cash, currency: r.currency,
    seats: r.seats, flight: r.flight || null,
  }));
}

function writeReport(offers, meta, cfg) {
  const summary = plan.summarize(offers, { premiumThreshold: cfg?.premiumThreshold ?? 1.25 });
  const picks = plan.recommend(summary, {
    limit: cfg?.report?.limit ?? 25,
    perRoute: cfg?.report?.perRoute ?? 3,
  });
  report.printConsole(summary, picks, { scanned: meta.scanned ?? 0 });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(HTML_PATH, report.buildHtml(summary, picks, {
    generatedAt: meta.generatedAt || new Date().toISOString(),
    scanned: meta.scanned ?? 0,
  }));
  console.log(`\nHTML report: ${HTML_PATH}`);
}

function cmdReport() {
  const cfg = fs.existsSync(CONFIG_PATH) ? loadConfig() : {};
  if (fs.existsSync(DB_PATH)) {
    const store = openStore();
    try {
      const s = store.stats();
      writeReport(offersFromDb(store), { scanned: s.searches, generatedAt: s.lastPull }, cfg);
    } finally { store.close(); }
    return;
  }
  if (fs.existsSync(LEGACY_RESULTS)) {
    const data = JSON.parse(fs.readFileSync(LEGACY_RESULTS, "utf8"));
    writeReport(data.offers, { scanned: data.scanned, generatedAt: data.generatedAt }, cfg);
    return;
  }
  throw new Error("No data yet — run `node search.js pull` (or `scan`) first.");
}

/* ------------------------------------------------- scan (UI fallback path) */

async function cmdScan(argv) {
  const cfg = loadConfig();
  const { launch, recordResponses, runTask } = require("./lib/browser.js");
  const { tasks, skipped } = plan.buildPlan(cfg);
  const queue = argv.limit ? tasks.slice(0, Number(argv.limit)) : tasks;

  if (skipped.length) {
    console.log(`Skipping ${skipped.length} date(s) outside the ${plan.BOOKING_HORIZON_DAYS}-day booking horizon.`);
  }
  if (!queue.length) throw new Error("Nothing to search — check config.dates.");
  console.log(`Driving the UI for ${queue.length} route/date combination(s).`);
  console.log("(`pull` is far cheaper if `capture` found a replayable request.)");

  const { browser, context } = await launch({
    headless: cfg.headless !== false && !argv.headed, storageState: STATE_PATH,
  });
  const page = await context.newPage();
  const rec = recordResponses(page);
  const store = new Store(DB_PATH);
  let total = 0;

  try {
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      const url = plan.fillTemplate(cfg.urlTemplate, t);
      process.stdout.write(`[${String(i + 1).padStart(3)}/${queue.length}] ${t.origin}->${t.destination} ${t.date} ... `);
      let result;
      try {
        result = await runTask(page, rec, url, { waitMs: cfg.waitMs ?? 8000, settleSelector: cfg.settleSelector || null });
      } catch (e) {
        console.log(`error: ${e.message.split("\n")[0]}`);
        continue;
      }
      for (const o of result.offers) {
        o.origin = o.origin || t.origin;
        o.destination = o.destination || t.destination;
        o.date = o.date || t.date;
        o.cabinNorm = plan.normalizeCabin(o.cabin);
      }
      const { stored } = store.upsertOffers(result.offers);
      total += stored;
      console.log(`${stored} price(s)`);
      if (i < queue.length - 1) await sleep(throttleDelay(cfg));
    }
  } finally {
    await browser.close();
    console.log(`\nStored ${total} price(s) to ${DB_PATH}`);
    store.close();
  }
}

/* ------------------------------------------------------------------- main */

function parseArgs(args) {
  const out = { _: [] };
  for (const a of args) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

const USAGE = `
SAS EuroBonus award search

  node search.js login                 log in once; saves the session
  node search.js capture               record a real search to learn the price request
  node search.js pull [--recipe=N]     replay it across routes/dates into the database
  node search.js query [filters]       look up the pulled data offline
  node search.js report                build the HTML calendar report
  node search.js scan                  fallback: drive the UI page by page

Query filters:
  --cheapest                  cheapest points price per destination
  --changes                   prices that moved between pulls
  --stats                     what the database holds
  --origin=CPH --destination=JFK --cabin=business
  --max-points=60000 --min-points=0 --max-cash=500 --min-seats=2
  --from=2026-10-01 --to=2026-12-31 --weekdays=5,0
  --saver                     only dates at the cheapest price for that route+cabin
  --order=points|date|cash|seats --limit=40
  --csv[=path]                also write the results as CSV

Examples:
  node search.js query --cheapest --cabin=business
  node search.js query --max-points=30000 --from=2026-10-01 --to=2026-11-30
  node search.js query --destination=BKK --saver --order=date
`;

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const cmd = argv._[0] || "help";
  switch (cmd) {
    case "login": return cmdLogin();
    case "capture": return cmdCapture();
    case "pull": return cmdPull(argv);
    case "query": return cmdQuery(argv);
    case "report": return cmdReport();
    case "scan": return cmdScan(argv);
    default:
      console.log(USAGE);
      if (cmd !== "help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  process.exitCode = 1;
});

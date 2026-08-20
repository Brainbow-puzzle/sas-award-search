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

// SAS's low-price calendar ("Lavpriskalender") shows award prices per date for a
// whole month, and shows them WITHOUT a login. That is the cheapest possible
// source: one request per month, no session to keep alive. Override via
// config.startUrl if your market's site differs.
const DEFAULT_START_URL = "https://www.sas.dk/";

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

async function cmdLogin(argv) {
  const { login } = require("./lib/browser.js");
  const cfg = fs.existsSync(CONFIG_PATH) ? loadConfig() : {};
  await login({
    startUrl: cfg.startUrl || DEFAULT_START_URL,
    storageStatePath: STATE_PATH,
    channel: browserChannel(argv, cfg),
  });
}

/** Which browser build to drive: the installed Chrome, or Playwright's own. */
function browserChannel(argv, cfg) {
  if (argv.chrome) return "chrome";
  if (argv.channel && argv.channel !== true) return argv.channel;
  return cfg.browserChannel || null;
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

/* ----------------------------------------------------------------- recipe */

/**
 * SAS's low-price calendar endpoint, as captured from www.sas.dk in Aug 2026.
 *
 * `capture` exists to *discover* which request returns prices. Once that is
 * known there is nothing left to discover, so a recipe can be written straight
 * from the URL — no browser, no human clicking through a calendar. Keeping the
 * known one here means a fresh clone can pull without capturing anything.
 *
 * If SAS changes the endpoint this goes stale; `capture` remains the way to
 * rediscover it, and `diagnose` the way to tell that it has gone stale.
 */
const KNOWN_URL =
  "https://www.sas.dk/bff/datepicker/flights/offers/v1" +
  "?market=dk-da&departureDate=2026-09-01&returnDate=2026-09-30&bookingFlow=points" +
  "&origin=CPH&destination=ARN&adult=1&child=0&infant=0&youth=0&tripType=RT";

const IATA_RE = /^[A-Z]{3}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Work out which query parameters carried the route and dates, so the URL can
 * be turned into a template. Values are validated by shape rather than trusted
 * by name: `from` means origin on one site and departure date on another.
 */
function inferObserved(url, argv) {
  const q = new URL(url).searchParams;
  const firstMatching = (names, test) => {
    for (const n of names) {
      const v = (q.get(n) || "").trim();
      if (v && test(v)) return v;
    }
    return null;
  };
  const iata = (v) => IATA_RE.test(v.toUpperCase());
  const iso = (v) => ISO_RE.test(v);

  return {
    origin: (argv.origin || firstMatching(["origin", "from", "departureAirport", "originCode"], iata) || "").toUpperCase() || null,
    destination: (argv.destination || firstMatching(["destination", "to", "arrivalAirport", "destinationCode"], iata) || "").toUpperCase() || null,
    date: argv.date || firstMatching(["departureDate", "outboundDate", "date", "from"], iso),
    returnDate: argv.returnDate || firstMatching(["returnDate", "inboundDate", "to"], iso),
  };
}

/** Whole days between two ISO dates. */
function daysBetween(a, b) {
  return Math.round((plan.parseISO(b) - plan.parseISO(a)) / 86400000);
}

function cmdRecipe(argv) {
  const url = argv.url === true ? null : (argv.url || KNOWN_URL);
  if (!url) throw new Error("--url needs a value, e.g. --url=\"https://...\"");

  const observed = inferObserved(url, argv);
  const missing = ["origin", "destination", "date"].filter((k) => !observed[k]);
  if (missing.length) {
    throw new Error(
      `Could not tell which query parameter holds: ${missing.join(", ")}.\n` +
      `Pass them explicitly, e.g. --origin=CPH --destination=ARN --date=2026-09-01`,
    );
  }

  // A request whose two dates span a week or more was asking for a window, not
  // a single departure — which is what makes one request cover a whole month.
  const span = observed.returnDate ? daysBetween(observed.date, observed.returnDate) : 0;
  const datesInCapture = argv.window === false ? 0 : (span >= 7 ? span + 1 : 0);

  // The headers a browser sends alongside this fetch. Cloudflare reads them to
  // tell a page's own XHR from a bare client, and a request carrying only
  // `accept` is answered with 403. These are what the real page sent.
  const origin = new URL(url).origin;
  const headers = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    referer: `${origin}/`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };

  const recipe = replayLib.buildRecipe(
    { method: (argv.method || "GET").toUpperCase(), url, headers, postData: null },
    observed,
    { name: `GET ${new URL(url).pathname}`, offersInCapture: null, datesInCapture },
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const existing = fs.existsSync(RECIPES_PATH)
    ? JSON.parse(fs.readFileSync(RECIPES_PATH, "utf8"))
    : { recipes: [] };
  // Newest first, so `pull` with no arguments uses what was just written.
  const recipes = [recipe, ...(existing.recipes || [])];
  fs.writeFileSync(RECIPES_PATH, JSON.stringify(
    { capturedAt: new Date().toISOString(), observed, recipes }, null, 2));

  const granularity = replayLib.dateGranularity(recipe);
  console.log(`\nWrote recipe [0] to ${RECIPES_PATH}\n`);
  console.log(`  ${recipe.name}`);
  console.log(`  varies: ${recipe.parameters.join(", ")}`);
  console.log(`  granularity: ${granularity}` +
    (granularity === "month" ? "  (one request per month per route)" : "  (one request per date)"));
  console.log(`  read from: ${observed.origin}->${observed.destination} ${observed.date}` +
    (observed.returnDate ? ` .. ${observed.returnDate}` : ""));
  if (argv.url === undefined) {
    console.log("\n  Using the built-in SAS low-price calendar endpoint.");
    console.log("  If SAS has changed it, run `capture` to rediscover and `diagnose` to check.");
  }
  console.log("\nNext:\n  node search.js pull --limit=3     # confirm it answers\n  node search.js pull\n");
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
          returnDate: returnDateFor(cfg, date, granularity),
          adults: cfg.adults || 1,
        });
      }
    }
  }
  return tasks;
}

/** Last day of the month `iso` falls in. */
function endOfMonth(iso) {
  const d = plan.parseISO(iso);
  return plan.toISO(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/**
 * What to put in a recipe's {returnDate}.
 *
 * An explicit tripLengthDays always wins — that is someone asking for a real
 * round trip. Failing that, a window recipe still needs *something*: SAS's date
 * picker takes departureDate and returnDate as the bounds of the grid it
 * returns (2026-09-01 .. 2026-09-30 for September), and materialize() throws
 * rather than guess, so leaving it null would fail every request in the run.
 * Spanning the anchor month reproduces exactly what the site itself sent.
 */
function returnDateFor(cfg, date, granularity) {
  if (cfg.tripLengthDays) {
    return plan.toISO(new Date(plan.parseISO(date).getTime() + cfg.tripLengthDays * 86400000));
  }
  return granularity === "month" ? endOfMonth(date) : null;
}

async function cmdPull(argv) {
  const cfg = loadConfig();
  const { recipes } = loadRecipes();
  const { recipe, index: idx } = replayLib.selectRecipe(recipes, {
    index: argv.recipe, granularity: argv.granularity,
  });

  const granularity = replayLib.dateGranularity(recipe);
  const tasks = buildPullTasks(cfg, granularity);
  const limited = argv.limit ? tasks.slice(0, Number(argv.limit)) : tasks;

  const perRequest = { day: "one date", month: "one month", none: "the endpoint's own window" };
  console.log(`Recipe [${idx}] ${recipe.name}`);
  console.log(`  each request covers ${perRequest[granularity]} — ${limited.length} request(s) to run`);

  // Neither granularity is simply better; say what this one costs and what it
  // buys, so the choice can be revisited before a long run rather than after.
  if (granularity === "day") {
    const monthly = recipes.some((r) => replayLib.dateGranularity(r) === "month");
    console.log("  one request per date: slower and more rate-limit exposure, but this is");
    console.log("  the full search result, so cabin, seats and flight number come with it.");
    if (monthly) {
      console.log("  (a month-granularity recipe was also captured — `pull --granularity=month`");
      console.log("   would cover the same span in far fewer requests, without cabins)");
    }
    if (limited.length > 200) {
      console.log(`  NOTE: ${limited.length} requests at the configured throttle will take a while.`);
      console.log("        Try `--limit=10` first to confirm the data looks right.");
    }
  } else {
    const daily = recipes.some((r) => replayLib.dateGranularity(r) === "day");
    if (daily) {
      console.log("  (a day-granularity recipe was also captured — `pull --granularity=day`");
      console.log("   costs ~30x the requests but carries cabin-level prices)");
    }
  }

  // Fail before opening a browser and burning the first request: materialize()
  // throws per call, so a template the tasks cannot fill would otherwise report
  // the same error once per request for the whole run.
  try {
    replayLib.materialize(recipe.urlTemplate, limited[0]);
    if (recipe.bodyTemplate) replayLib.materialize(recipe.bodyTemplate, limited[0]);
  } catch (e) {
    throw new Error(
      `${e.message}\n` +
      "Set tripLengthDays in config.json if this recipe needs a return date, " +
      "or capture a one-way search instead.",
    );
  }

  const { launch } = require("./lib/browser.js");
  const { browser, context } = await launch({
    headless: !argv.headed,
    storageState: STATE_PATH,
    channel: browserChannel(argv, cfg),
  });

  // Load the site itself before calling its API.
  //
  // www.sas.dk sits behind Cloudflare, which issues its __cf_bm cookie to
  // clients that have actually loaded a page. A context created fresh for the
  // replay has no cookies and sends no Referer, and every request comes back
  // 403. A browser never calls this endpoint cold either — the page loads
  // first and its own scripts fetch afterwards, which is exactly what this
  // reproduces. Failure is non-fatal: the requests still run, and their status
  // codes say more than a guess here would.
  const firstUrl = replayLib.materialize(recipe.urlTemplate, limited[0]);
  const origin = new URL(firstUrl).origin;
  process.stdout.write(`Opening ${origin} to establish a session ... `);
  try {
    const warmup = await context.newPage();
    await warmup.goto(origin, { waitUntil: "domcontentloaded", timeout: 45000 });
    // Bot-management scripts set their cookie after load, not during it.
    await warmup.waitForTimeout(2500);
    await warmup.close();
    const named = (await context.cookies(origin)).map((c) => c.name);
    const cleared = named.includes("__cf_bm");
    console.log(named.length ? `${named.length} cookie(s)${cleared ? ", including __cf_bm" : ""}` : "no cookies set");
    if (!cleared) {
      console.log("  Cloudflare has not cleared this browser (no __cf_bm), so requests are");
      console.log("  likely to be refused. Run `node search.js session --chrome` first: it");
      console.log("  opens a real window where you can accept the cookie banner, and saves");
      console.log("  the result for `pull` to reuse.");
    }
  } catch (e) {
    console.log(`could not open it (${e.message.split("\n")[0]})`);
  }

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
        const why = res.status === 403 || res.status === 503 ? "blocked"
          : res.status === 401 || res.status === 302 ? "not authorised"
          : "no JSON";
        console.log(`HTTP ${res.status}, ${why}`);
        emptyStreak++;
        if (emptyStreak === 3) {
          if (res.status === 403 || res.status === 503) {
            console.log("\n  Three blocked responses. The endpoint is refusing this client, not");
            console.log("  refusing your account — no login will change it. Re-run `capture` so the");
            console.log("  recipe carries the headers the site actually sends.\n");
          } else {
            console.log("\n  Three non-JSON responses in a row — re-run `node search.js login`.\n");
          }
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

/* --------------------------------------------------------------- diagnose */

/**
 * Re-read the payloads `capture` saved and say, offline, whether prices can be
 * extracted from them — and if not, exactly which field to teach the harvester.
 */
function cmdDiagnose(argv) {
  const { diagnose } = require("./lib/diagnose.js");
  const dir = argv.dir || CAPTURE_DIR;
  const d = diagnose(dir);

  if (argv.json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  console.log(`\nAnalysing ${d.payloads} saved payload(s) in ${dir}\n`);

  for (const r of d.results) {
    if (r.error) {
      console.log(`  ${r.file}\n      unreadable: ${r.error}\n`);
      continue;
    }
    const label = `${r.method} ${shortUrl(r.url)}`;
    if (r.offers === 0) {
      console.log(`  ${label}\n      no prices`);
      if (r.nearMisses.length) {
        console.log(`      ${r.nearMisses.length} number(s) in award range that the harvester ignored:`);
        for (const g of r.nearMisses) {
          console.log(`        ${g.shape}`);
          console.log(`          ${g.samples.map(num).join(", ")}${g.count > g.samples.length ? `  (x${g.count})` : ""}`);
        }
        console.log("      -> if any of those are award points, widen isPointsKey() in lib/harvest.js");
      } else {
        const li = r.largestInteger;
        console.log(`      nothing points-like at all${li !== null ? ` (largest integer: ${num(li)})` : ""}`);
      }
      console.log("");
      continue;
    }

    console.log(`  ${label}\n      ${r.offers} price(s)${r.calendarStyle ? "  — CALENDAR-STYLE, covers a whole window per request" : ""}`);
    const a = r.annotations;
    console.log(`      annotated: date ${a.date}/${r.offers}  cabin ${a.cabin}/${r.offers}  ` +
                `dest ${a.destination}/${r.offers}  taxes ${a.cash}/${r.offers}  seats ${a.seats}/${r.offers}`);
    if (r.dates.count) console.log(`      dates: ${r.dates.count} distinct, ${r.dates.first} .. ${r.dates.last}`);

    for (const [kind, m] of Object.entries(r.missingAnnotations)) {
      const severity = kind === "date" ? "DROPPED BY PULL" : "degrades filters";
      console.log(`      ${kind}: only ${m.have}/${m.of} annotated (${severity}); candidate field(s):`);
      for (const c of m.candidates) {
        console.log(`        ${c.shape}  e.g. ${c.samples.map((s) => JSON.stringify(s)).join(", ")}`);
      }
    }
    console.log("");
  }

  console.log("-".repeat(64));
  if (!d.totalOffers) {
    console.log(`VERDICT: no prices extractable from any of ${d.payloads} payload(s).`);
    console.log("\nThis is the answer that matters, and it is fixable: the payloads are on disk,");
    console.log("so you can edit lib/harvest.js and re-run `diagnose` as often as you like");
    console.log("without another login or another capture.");
    process.exitCode = 1;
    return;
  }
  console.log(`VERDICT: ${num(d.totalOffers)} price(s) extractable from ${d.usablePayloads} of ${d.payloads} payload(s).`);
  if (d.best) {
    console.log(`Best source: ${d.best.method} ${shortUrl(d.best.url)} (${d.best.offers} prices` +
                `${d.best.calendarStyle ? ", whole window per request" : ", one date per request"})`);
    if (!d.best.calendarStyle) {
      console.log("\nThat recipe covers a single date per request. Re-run `capture` using the");
      console.log("site's flexible-date/calendar view to cut the request count dramatically.");
    }
  }
  const dateGap = d.results.some((r) => r.offers > 0 && r.annotations.date < r.offers);
  if (dateGap) {
    console.log("\nWARNING: some prices carry no date. `pull` drops those rather than guessing,");
    console.log("so they are silent losses. Extend the date matcher using the candidates above.");
  }
  console.log("");
}

/** Host + path only; capture URLs carry long query strings that wreck the layout. */
function shortUrl(u) {
  try {
    const p = new URL(u);
    return `${p.host}${p.pathname}`;
  } catch {
    return String(u).slice(0, 70);
  }
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

  node search.js session [--chrome]    open a real browser once so the API stops refusing
  node search.js login                 same thing; also lets you sign in
  node search.js capture               record a real search to learn the price request
  node search.js diagnose              re-check captured payloads offline: can prices be read?
  node search.js recipe                skip capture: build the recipe from a known URL
  node search.js pull [--recipe=N]     replay it across routes/dates into the database
       --granularity=day|month         one request per date (rich) or per month (cheap)
       --headed --chrome               drive a visible / real-Chrome browser
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
    case "login": return cmdLogin(argv);
    case "session": return cmdLogin(argv);
    case "capture": return cmdCapture();
    case "diagnose": return cmdDiagnose(argv);
    case "recipe": return cmdRecipe(argv);
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

#!/usr/bin/env node
"use strict";

/**
 * SAS EuroBonus award scanner.
 *
 * Usage:
 *   node search.js login            one-time manual login, saves the session
 *   node search.js capture          record one hand-driven search to learn the URL + payload shape
 *   node search.js scan             run the configured matrix and write results
 *   node search.js report           rebuild the report from the last scan
 *
 * See README.md.
 */

const fs = require("fs");
const path = require("path");

const plan = require("./lib/plan.js");
const report = require("./lib/report.js");

const ROOT = __dirname;
const CONFIG_PATH = process.env.SAS_CONFIG || path.join(ROOT, "config.json");
const OUT_DIR = path.join(ROOT, "out");
const STATE_PATH = path.join(ROOT, ".session.json");
const RESULTS_PATH = path.join(OUT_DIR, "offers.json");
const HTML_PATH = path.join(OUT_DIR, "report.html");
const CAPTURE_DIR = path.join(OUT_DIR, "captured");

const DEFAULT_START_URL = "https://www.flysas.com/en/";

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `No config at ${CONFIG_PATH}.\n` +
      `Copy config.example.json to config.json and edit it.`,
    );
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!cfg.dates || !cfg.dates.from || !cfg.dates.to) {
    throw new Error("config.dates.from and config.dates.to are required (YYYY-MM-DD).");
  }
  return cfg;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Requests are spaced out with jitter and run strictly one at a time. This is a
 * personal-scale search tool; it should look like a person searching, not like
 * a crawler. Keep the delays generous.
 */
function throttleDelay(cfg) {
  const min = cfg.throttle?.minMs ?? 4000;
  const max = cfg.throttle?.maxMs ?? 9000;
  return min + Math.random() * Math.max(0, max - min);
}

async function cmdLogin() {
  const { login } = require("./lib/browser.js");
  const cfg = fs.existsSync(CONFIG_PATH) ? loadConfig() : {};
  await login({ startUrl: cfg.startUrl || DEFAULT_START_URL, storageStatePath: STATE_PATH });
}

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

async function cmdScan(argv) {
  const cfg = loadConfig();
  const { launch, recordResponses, runTask } = require("./lib/browser.js");

  const { tasks, skipped } = plan.buildPlan(cfg);
  const limit = Number(argv.limit) || tasks.length;
  const queue = tasks.slice(0, limit);

  if (skipped.length) {
    console.log(`Skipping ${skipped.length} date(s) outside the ${plan.BOOKING_HORIZON_DAYS}-day booking horizon.`);
  }
  if (!queue.length) throw new Error("Nothing to search — check config.dates.");
  console.log(`Searching ${queue.length} route/date combination(s).`);
  if (!fs.existsSync(STATE_PATH)) {
    console.log("No saved session found — run `node search.js login` first if results come back empty.");
  }

  const headless = cfg.headless !== false && !argv.headed;
  const { browser, context } = await launch({ headless, storageState: STATE_PATH });
  const page = await context.newPage();
  const rec = recordResponses(page);

  const collected = [];
  let emptyStreak = 0;
  try {
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      const url = plan.fillTemplate(cfg.urlTemplate, t);
      process.stdout.write(
        `[${String(i + 1).padStart(3)}/${queue.length}] ${t.origin}->${t.destination} ${t.date} ... `,
      );
      let result;
      try {
        result = await runTask(page, rec, url, {
          waitMs: cfg.waitMs ?? 8000,
          settleSelector: cfg.settleSelector || null,
        });
      } catch (e) {
        console.log(`error: ${e.message.split("\n")[0]}`);
        continue;
      }

      // The scan can only annotate what the payload carried; fill in the route
      // and date we asked for when the response left them implicit.
      for (const o of result.offers) {
        o.origin = o.origin || t.origin;
        o.destination = o.destination || t.destination;
        o.date = o.date || t.date;
        o.searchedDate = t.date;
      }
      collected.push(...result.offers);
      console.log(`${result.offers.length} offer(s) from ${result.responses} response(s)`);

      emptyStreak = result.offers.length ? 0 : emptyStreak + 1;
      if (emptyStreak === 5) {
        console.log(
          "\n  Five searches in a row returned no prices. Likely causes: the session\n" +
          "  expired (re-run `login`), or urlTemplate is wrong (re-run `capture`).\n",
        );
      }
      if (i < queue.length - 1) await sleep(throttleDelay(cfg));
    }
  } finally {
    await browser.close();
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(
    { generatedAt: new Date().toISOString(), scanned: queue.length, offers: collected }, null, 2));
  console.log(`\nSaved ${collected.length} offer(s) to ${RESULTS_PATH}`);
  writeReport({ scanned: queue.length, offers: collected }, cfg);
}

function writeReport(data, cfg) {
  const summary = plan.summarize(data.offers, { premiumThreshold: cfg?.premiumThreshold ?? 1.25 });
  const picks = plan.recommend(summary, {
    limit: cfg?.report?.limit ?? 25,
    perRoute: cfg?.report?.perRoute ?? 3,
  });
  report.printConsole(summary, picks, { scanned: data.scanned });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(HTML_PATH, report.buildHtml(summary, picks, {
    generatedAt: data.generatedAt || new Date().toISOString(),
    scanned: data.scanned,
  }));
  console.log(`\nHTML report: ${HTML_PATH}`);
}

function cmdReport() {
  if (!fs.existsSync(RESULTS_PATH)) throw new Error(`No results at ${RESULTS_PATH} — run \`scan\` first.`);
  const data = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
  const cfg = fs.existsSync(CONFIG_PATH) ? loadConfig() : {};
  writeReport(data, cfg);
}

function parseArgs(args) {
  const out = { _: [] };
  for (const a of args) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(a);
  }
  return out;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const cmd = argv._[0] || "help";
  switch (cmd) {
    case "login": return cmdLogin();
    case "capture": return cmdCapture();
    case "scan": return cmdScan(argv);
    case "report": return cmdReport();
    default:
      console.log(fs.readFileSync(path.join(ROOT, "README.md"), "utf8").split("\n").slice(0, 40).join("\n"));
      if (cmd !== "help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  process.exitCode = 1;
});

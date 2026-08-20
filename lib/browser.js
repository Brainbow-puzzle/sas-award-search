"use strict";

/**
 * Browser IO for the award scan.
 *
 * Everything goes through a real Chromium session rather than direct API calls,
 * for two reasons: SAS's award search is behind a login wall, and its booking
 * backend is protected in ways a bare HTTP client trips over. Driving the same
 * page a person would use keeps the session valid and the request pattern
 * ordinary.
 *
 * Prices are read from the JSON the page itself fetches, not from the DOM.
 * Network payloads survive the cosmetic redesigns that break CSS selectors.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { harvest, dedupe } = require("./harvest.js");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. Run:\n" +
      "  npm install\n" +
      "  npx playwright install chromium",
    );
  }
}

const JSONISH = /\bapplication\/(json|.*\+json)\b/i;

function isInteresting(url) {
  // Ignore analytics/telemetry noise; keep anything that could carry an offer.
  return !/(google|doubleclick|facebook|hotjar|newrelic|sentry|adobedtm|demdex|optimizely|cloudflareinsights|clarity\.ms)/i.test(url);
}

async function launch({ headless = false, storageState = null, slowMo = 0 } = {}) {
  const { chromium } = loadPlaywright();
  const launchOpts = { headless, slowMo };
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;

  const browser = await chromium.launch(launchOpts);
  const contextOpts = {
    locale: "en-GB",
    viewport: { width: 1440, height: 900 },
  };
  if (storageState && fs.existsSync(storageState)) contextOpts.storageState = storageState;
  const context = await browser.newContext(contextOpts);
  return { browser, context };
}

/**
 * Attach a response recorder to a page. Returns a handle whose `drain()` gives
 * the JSON bodies seen since the last drain.
 */
function recordResponses(page, { onBody = null } = {}) {
  const bodies = [];
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!isInteresting(url)) return;
      const ctype = response.headers()["content-type"] || "";
      if (!JSONISH.test(ctype)) return;
      const text = await response.text();
      if (!text || text.length > 8_000_000) return;
      let json;
      try { json = JSON.parse(text); } catch { return; }
      const entry = { url, status: response.status(), json };
      bodies.push(entry);
      if (onBody) onBody(entry);
    } catch {
      // A response body can vanish on navigation; never let that kill the run.
    }
  });
  return {
    drain() { return bodies.splice(0, bodies.length); },
    get count() { return bodies.length; },
  };
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

/**
 * Open a browser for a manual login and persist the session so later scans run
 * unattended. Credentials are never read, stored, or transmitted by this tool —
 * the user types them into the real SAS page.
 */
async function login({ startUrl, storageStatePath }) {
  const { browser, context } = await launch({ headless: false });
  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log(
    "\nA browser window is open.\n" +
    "  1. Log in to your EuroBonus account (solve any 2FA/consent prompts).\n" +
    "  2. Leave the browser on a logged-in page.\n",
  );
  await prompt("Press Enter here once you are logged in... ");
  await context.storageState({ path: storageStatePath });
  await browser.close();
  console.log(`Session saved to ${storageStatePath}`);
}

/**
 * Record one hand-driven award search.
 *
 * This is where the tool learns how SAS actually asks for prices. It keeps the
 * full request (method, URL, headers, body) of every response that contained
 * points, then turns each into a re-aimable "recipe". Later pulls replay those
 * requests directly instead of driving the UI.
 */
async function capture({ startUrl, storageStatePath, outDir }) {
  const { buildRecipe } = require("./replay.js");
  fs.mkdirSync(outDir, { recursive: true });
  const { browser, context } = await launch({ headless: false, storageState: storageStatePath });
  const page = await context.newPage();

  // Keep the request beside each response so a recipe can be rebuilt from it.
  const seen = [];
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!isInteresting(url)) return;
      const ctype = response.headers()["content-type"] || "";
      if (!JSONISH.test(ctype)) return;
      const text = await response.text();
      if (!text || text.length > 8_000_000) return;
      let json;
      try { json = JSON.parse(text); } catch { return; }
      const req = response.request();
      let headers = {};
      try { headers = await req.allHeaders(); } catch { headers = req.headers(); }
      seen.push({
        url, status: response.status(), json,
        request: { method: req.method(), url: req.url(), headers, postData: req.postData() || null },
      });
    } catch {
      // Bodies can vanish on navigation; never let that end the capture.
    }
  });

  await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log(
    "\nA browser window is open.\n" +
    "  1. Run an award search by hand, paying with points.\n" +
    "  2. If the site offers a flexible-date or calendar view, USE IT — a request\n" +
    "     that returns a whole month is worth dozens of single-date searches.\n" +
    "  3. Wait until prices are fully on screen.\n",
  );
  await prompt("Press Enter here once the results are showing... ");

  // Literal values beat guessing which field means what, so ask.
  console.log("\nNow tell me what you just searched, so the request can be re-aimed.");
  const observed = {
    origin: (await prompt("  Origin IATA code (e.g. CPH): ")).trim().toUpperCase(),
    destination: (await prompt("  Destination IATA code (e.g. JFK): ")).trim().toUpperCase(),
    date: (await prompt("  Outbound date (YYYY-MM-DD): ")).trim(),
    returnDate: (await prompt("  Return date (YYYY-MM-DD, blank if one-way): ")).trim() || null,
  };

  const recipes = [];
  seen.forEach((entry, i) => {
    const offers = dedupe(harvest(entry.json, { source: entry.url }));
    const name = entry.url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 100);
    fs.writeFileSync(
      path.join(outDir, `${String(i).padStart(3, "0")}_${name}.json`),
      JSON.stringify({ url: entry.url, status: entry.status, request: entry.request, json: entry.json }, null, 2),
    );
    if (offers.length) {
      recipes.push(buildRecipe(entry.request, observed, {
        offersInCapture: offers.length,
        name: `${entry.request.method} ${new URL(entry.url).pathname}`,
      }));
    }
  });
  await browser.close();

  // Best first: most prices returned, and prefer one that needs no date because
  // it covers a whole window per request.
  recipes.sort((a, b) => {
    const aWindow = !a.parameters.includes("date");
    const bWindow = !b.parameters.includes("date");
    if (aWindow !== bWindow) return aWindow ? -1 : 1;
    return (b.offersInCapture || 0) - (a.offersInCapture || 0);
  });

  const recipePath = path.join(outDir, "..", "recipes.json");
  fs.writeFileSync(recipePath, JSON.stringify({ capturedAt: new Date().toISOString(), observed, recipes }, null, 2));

  console.log(`\nRecorded ${seen.length} JSON response(s) to ${outDir}`);
  if (!recipes.length) {
    console.log(
      "\nNo response contained recognisable points data.\n" +
      "The raw payloads are saved above — inspect them, or share one, to extend lib/harvest.js.",
    );
    return { recipes: [] };
  }

  console.log(`\nBuilt ${recipes.length} replayable recipe(s), best first:\n`);
  recipes.forEach((r, i) => {
    const scope = r.parameters.includes("date") ? "one date per request" : "whole window per request";
    console.log(`  [${i}] ${r.name}`);
    console.log(`      ${r.offersInCapture} price(s) in capture — ${scope}`);
    console.log(`      varies: ${r.parameters.join(", ") || "(nothing detected)"}`);
  });
  console.log(`\nSaved to ${recipePath}`);
  console.log("Run `node search.js pull` to harvest with recipe [0], or --recipe=N to choose another.\n");
  return { recipes };
}

/**
 * Turn an observed search URL into a template by replacing the values that vary
 * per query (airport codes, dates) with placeholders.
 */
function deriveTemplate(observedUrl) {
  let url;
  try { url = new URL(observedUrl); } catch { return observedUrl; }

  const IATA = /^[A-Z]{3}$/;
  const DATEY = /^(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}\/\d{2}\/\d{4})$/;
  const fmtFor = (v) => (v.includes("-") ? "" : v.length === 8 ? ":YYYYMMDD" : ":DD/MM/YYYY");

  let originDone = false;
  let dateDone = false;
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (IATA.test(value)) {
      url.searchParams.set(key, originDone ? "{destination}" : "{origin}");
      originDone = true;
    } else if (DATEY.test(value)) {
      url.searchParams.set(key, dateDone ? `{returnDate${fmtFor(value)}}` : `{date${fmtFor(value)}}`);
      dateDone = true;
    }
  }
  // URLSearchParams percent-encodes the braces; put them back so the template
  // stays readable and fillTemplate can see the placeholders.
  return decodeURIComponent(url.toString());
}

/** Run one origin/destination/date query and return the offers found. */
async function runTask(page, rec, url, { waitMs = 6000, settleSelector = null }) {
  rec.drain();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (settleSelector) {
    await page.waitForSelector(settleSelector, { timeout: waitMs }).catch(() => {});
  }
  // The results arrive by XHR after load; give them a bounded window.
  await page.waitForLoadState("networkidle", { timeout: waitMs }).catch(() => {});
  await page.waitForTimeout(800);

  const bodies = rec.drain();
  const offers = [];
  for (const b of bodies) offers.push(...harvest(b.json, { source: b.url }));
  return { offers: dedupe(offers), responses: bodies.length };
}

module.exports = { launch, login, capture, recordResponses, runTask, deriveTemplate, prompt };

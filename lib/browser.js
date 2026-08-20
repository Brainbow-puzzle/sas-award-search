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

async function launch({ headless = false, storageState = null, slowMo = 0, channel = null } = {}) {
  const { chromium } = loadPlaywright();
  const launchOpts = { headless, slowMo };
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
  // Playwright's bundled Chromium is a build no ordinary visitor runs. Pointing
  // it at the Chrome already installed on this machine is both a closer match
  // for how the site is normally used and one fewer thing for a CDN to find odd.
  if (channel) launchOpts.channel = channel;

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
/**
 * Establish a session the replay can reuse.
 *
 * Named for logging in, and it still does that, but on SAS the account is
 * optional and the cookies that matter are the ordinary ones any visitor
 * collects: the consent choice, and Cloudflare's __cf_bm, which it issues to
 * clients that have actually loaded and run the page. A headless context that
 * never accepted the cookie banner collects neither, and every API call is
 * answered 403.
 */
async function login({ startUrl, storageStatePath, channel = null }) {
  const { browser, context } = await launch({ headless: false, channel });
  const page = await context.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log(
    "\nA browser window is open.\n" +
    "  1. Accept or reject the cookie banner — either is fine, but the choice\n" +
    "     has to be made or the page never finishes setting up.\n" +
    "  2. Wait for the page to finish loading.\n" +
    "  3. Optional: log in, if you want prices only your account can see.\n",
  );
  await prompt("Press Enter here once the page has settled... ");
  const cookies = await context.cookies();
  await context.storageState({ path: storageStatePath });
  await browser.close();
  console.log(`\nSession saved to ${storageStatePath} (${cookies.length} cookie(s))`);
  if (!cookies.some((c) => c.name === "__cf_bm")) {
    console.log("Note: no __cf_bm cookie. Cloudflare did not clear this browser, so");
    console.log("`pull` may still be refused. Try again with --chrome.");
  }
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
    "\nA browser window is open. You do NOT need to log in — SAS shows award\n" +
    "prices to anonymous visitors. Tick \"Betal med point\" / \"Pay with points\".\n\n" +
    "There are two searches worth capturing, and they are not interchangeable:\n\n" +
    "  A. Low-price calendar (\"Lavpriskalender\")\n" +
    "     One request returns a whole month, so a season costs a dozen calls.\n" +
    "     But it shows one headline price per date — usually no cabin, no seat\n" +
    "     count, no flight number.\n\n" +
    "  B. A normal search for ONE specific date\n" +
    "     One request per date, so ~30x the calls. In exchange you get the full\n" +
    "     result: prices per cabin, seats left, flight numbers.\n\n" +
    "Capture both if you want the choice later — run this command twice, or do\n" +
    "both searches now before pressing Enter. `pull --granularity=day|month`\n" +
    "then picks between them.\n\n" +
    "Wait until prices are fully on screen before continuing.\n",
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
        // Distinct dates decide how finely the recipe must be iterated, and a
        // response can cover a whole month while being addressed by one date.
        datesInCapture: new Set(offers.map((o) => o.date).filter(Boolean)).size,
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

  const { dateGranularity } = require("./replay.js");
  console.log(`\nBuilt ${recipes.length} replayable recipe(s), cheapest first:\n`);
  recipes.forEach((r, i) => {
    const g = dateGranularity(r);
    const scope = {
      day: "one date per request — carries cabin/seats detail",
      month: "one month per request — cheap, usually no cabin detail",
      none: "the endpoint's own window per request",
    }[g];
    console.log(`  [${i}] ${r.name}   (${g})`);
    console.log(`      ${r.offersInCapture} price(s) in capture — ${scope}`);
    console.log(`      varies: ${r.parameters.join(", ") || "(nothing detected)"}`);
  });
  const kinds = new Set(recipes.map(dateGranularity));
  if (!kinds.has("day")) {
    console.log("\n  No day-granularity recipe here. If you want cabin-level prices,");
    console.log("  re-run `capture` and search ONE specific date rather than the calendar.");
  }
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

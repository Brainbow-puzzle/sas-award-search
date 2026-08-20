"use strict";
/**
 * End-to-end check of the replay path against the local mock calendar endpoint:
 * captured request -> recipe -> replay -> harvest -> SQLite -> query.
 *
 * Requires playwright. Run: node test-replay-e2e.js
 */
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (!/SQLite is an experimental feature/.test(w.message)) console.warn(w.stack || String(w));
});

const assert = require("assert");
const { fork } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const replayLib = require("./lib/replay.js");
const plan = require("./lib/plan.js");
const { harvest, dedupe } = require("./lib/harvest.js");
const { Store } = require("./lib/store.js");

const PORT = 8232;
let pass = 0;
const ok = (label) => { console.log(`PASS  ${label}`); pass++; };

async function main() {
  const server = fork(path.join(__dirname, "mock", "server.js"), {
    env: { ...process.env, MOCK_PORT: String(PORT) }, stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 700));

  const dbFile = path.join(os.tmpdir(), `sas-replay-${Date.now()}.db`);
  const store = new Store(dbFile);
  let browser;

  try {
    // A capture of a month-view search: CPH->JFK, October 2026.
    const captured = {
      method: "GET",
      url: `http://127.0.0.1:${PORT}/api/calendar?from=CPH&to=JFK&month=2026-10`,
      postData: null,
      headers: { "accept": "application/json", "host": `127.0.0.1:${PORT}`, "content-length": "0" },
    };
    const recipe = replayLib.buildRecipe(captured, {
      origin: "CPH", destination: "JFK", date: "2026-10-01", returnDate: null,
    }, { offersInCapture: 40 });

    assert.strictEqual(replayLib.dateGranularity(recipe), "month",
      `expected a month recipe, got ${replayLib.dateGranularity(recipe)}`);
    ok(`recipe classified as month-granularity: ${recipe.urlTemplate.split("?")[1]}`);

    assert.ok(!("host" in recipe.headers) && !("content-length" in recipe.headers),
      "hop-by-hop headers must not be replayed");
    ok("hop-by-hop headers dropped");

    const { launch } = require("./lib/browser.js");
    let context;
    ({ browser, context } = await launch({ headless: true }));

    // Re-aim the captured CPH->JFK October request at other routes and months.
    const tasks = [];
    for (const destination of ["JFK", "CDG", "BKK"]) {
      for (const date of ["2026-10-01", "2026-11-01"]) {
        tasks.push({ origin: "CPH", destination, date, adults: 1 });
      }
    }

    let totalStored = 0;
    for (const t of tasks) {
      const res = await replayLib.replay(context.request, recipe, t);
      assert.strictEqual(res.status, 200, `replay returned HTTP ${res.status}`);
      assert.ok(res.json, "replay returned no JSON");

      const offers = dedupe(harvest(res.json, { source: recipe.name }));
      const usable = [];
      for (const o of offers) {
        o.origin = o.origin || t.origin;
        o.destination = o.destination || t.destination;
        o.cabinNorm = plan.normalizeCabin(o.cabin);
        if (o.date) usable.push(o);
      }
      // Dates must come from the payload, not the anchor: this is a month view.
      assert.ok(new Set(usable.map((o) => o.date)).size > 20,
        `expected a month of distinct dates, got ${new Set(usable.map((o) => o.date)).size}`);
      totalStored += store.upsertOffers(usable).stored;
    }
    ok(`${tasks.length} replayed requests yielded ${totalStored} prices (~${Math.round(totalStored / tasks.length)} per request)`);

    assert.ok(totalStored > 200, `expected a few hundred prices from 6 requests, got ${totalStored}`);
    ok("one request really does cover a whole month");

    // The data must now answer questions offline.
    const cheap = store.query({ cabin: "economy", maxPoints: 20000, limit: 500 });
    assert.ok(cheap.length > 0, "no cheap economy found");
    assert.ok(cheap.every((r) => r.points <= 20000 && r.cabin === "economy"), "filter leaked");
    ok(`query --cabin=economy --max-points=20000 -> ${cheap.length} rows`);

    const perDest = store.cheapestPerDestination({ origin: "CPH", cabin: "business" });
    assert.strictEqual(perDest.length, 3, `expected 3 destinations, got ${perDest.length}`);
    assert.ok(perDest[0].points <= perDest[perDest.length - 1].points, "not sorted by points");
    ok(`cheapest-per-destination -> ${perDest.map((d) => `${d.destination}:${d.points}`).join(" ")}`);

    const fridays = store.query({ weekdays: [5], limit: 500 });
    assert.ok(fridays.length > 0, "no Friday rows");
    const allFri = fridays.every((r) => new Date(r.depart_date + "T00:00:00Z").getUTCDay() === 5);
    assert.ok(allFri, "weekday filter returned non-Fridays");
    ok(`weekday filter -> ${fridays.length} Friday departures, all genuinely Fridays`);

    const saver = store.query({ destination: "CDG", cabin: "business", saverOnly: true, limit: 500 });
    const anyCdg = store.query({ destination: "CDG", cabin: "business", limit: 500 });
    assert.ok(saver.length > 0 && saver.length < anyCdg.length, "saver filter did not narrow results");
    const best = Math.min(...anyCdg.map((r) => r.points));
    assert.ok(saver.every((r) => r.points === best), "saver rows are not all at the baseline");
    ok(`saver filter -> ${saver.length}/${anyCdg.length} CDG business dates at ${best} pts`);

    // Re-pulling the same data must not duplicate rows.
    const before = store.stats().offers;
    const res = await replayLib.replay(context.request, recipe, tasks[0]);
    const again = dedupe(harvest(res.json, { source: recipe.name })).map((o) => ({
      ...o, origin: o.origin || "CPH", destination: o.destination || "JFK",
      cabinNorm: plan.normalizeCabin(o.cabin),
    })).filter((o) => o.date);
    store.upsertOffers(again);
    assert.strictEqual(store.stats().offers, before, "re-pull created duplicate offers");
    ok(`re-pull is idempotent (${before} offers before and after)`);

    console.log("\nreplay path end-to-end OK");
  } finally {
    if (browser) await browser.close().catch(() => {});
    store.close();
    fs.rmSync(dbFile, { force: true });
    fs.rmSync(dbFile + "-wal", { force: true });
    fs.rmSync(dbFile + "-shm", { force: true });
    server.kill();
  }
}

main().catch((e) => {
  console.error(`\nFAIL  ${e.message}`);
  process.exitCode = 1;
});

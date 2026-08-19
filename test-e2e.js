"use strict";
/**
 * End-to-end check of the whole pipeline against the local mock site in mock/:
 * real browser -> XHR capture -> harvest -> summarize -> report.
 *
 * Verifies the plumbing offline. It cannot verify anything about SAS's real
 * site, which is what `capture` is for.
 *
 * Requires playwright. Run: node test-e2e.js
 */
const assert = require("assert");
const { fork } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const plan = require("./lib/plan.js");
const report = require("./lib/report.js");

const PORT = 8231;

async function main() {
  const server = fork(path.join(__dirname, "mock", "server.js"), {
    env: { ...process.env, MOCK_PORT: String(PORT) },
    stdio: "ignore",
  });
  // Give the mock a moment to bind.
  await new Promise((r) => setTimeout(r, 700));

  try {
    const { launch, recordResponses, runTask } = require("./lib/browser.js");
    const cfg = {
      urlTemplate: `http://127.0.0.1:${PORT}/book?from={origin}&to={destination}&out={date:YYYYMMDD}&adt={adults}`,
      origins: ["CPH"],
      destinations: ["JFK", "CDG"],
      dates: { from: "2026-10-01", to: "2026-10-04" },
      adults: 1,
    };
    const { tasks } = plan.buildPlan(cfg, { today: new Date(Date.UTC(2026, 7, 19)) });
    assert.strictEqual(tasks.length, 8, `expected 8 tasks, got ${tasks.length}`);

    const { browser, context } = await launch({ headless: true });
    const page = await context.newPage();
    const rec = recordResponses(page);
    const offers = [];
    try {
      for (const t of tasks) {
        const url = plan.fillTemplate(cfg.urlTemplate, t);
        const res = await runTask(page, rec, url, { waitMs: 3000 });
        for (const o of res.offers) {
          o.origin = o.origin || t.origin;
          o.destination = o.destination || t.destination;
          o.date = o.date || t.date;
        }
        offers.push(...res.offers);
      }
    } finally {
      await browser.close();
    }

    assert.ok(offers.length > 0, "no offers harvested from the mock site");
    console.log(`PASS  harvested ${offers.length} offer(s) from ${tasks.length} searches`);

    // Cabin, taxes and route must survive the round trip.
    const withCabin = offers.filter((o) => plan.normalizeCabin(o.cabin));
    assert.ok(withCabin.length > 0, "no offer carried a recognisable cabin");
    console.log(`PASS  ${withCabin.length} offer(s) carried a cabin`);

    const withCash = offers.filter((o) => o.cash !== null && o.cash !== undefined);
    assert.ok(withCash.length > 0, "no offer carried taxes");
    console.log(`PASS  ${withCash.length} offer(s) carried taxes`);

    const summary = plan.summarize(offers);
    const cabins = new Set(summary.byDate.map((r) => r.cabinNorm));
    assert.ok(cabins.has("economy") && cabins.has("business"),
      `expected both cabins, saw ${[...cabins].join(",")}`);
    console.log(`PASS  summarize separated cabins: ${[...cabins].join(", ")}`);

    assert.ok(summary.byDate.some((r) => r.isSaver), "no saver-priced date identified");
    assert.ok(summary.byDate.some((r) => !r.isSaver), "mock should include above-saver dates");
    console.log("PASS  saver vs above-saver classification");

    // Economy must never baseline against business.
    const ecoBase = summary.baselines.find((b) => b.cabin === "economy" && b.destination === "JFK");
    const bizBase = summary.baselines.find((b) => b.cabin === "business" && b.destination === "JFK");
    assert.ok(ecoBase.points < bizBase.points, "cabin baselines look crossed");
    console.log(`PASS  per-cabin baselines (eco ${ecoBase.points} < biz ${bizBase.points})`);

    const html = report.buildHtml(summary, plan.recommend(summary, {}), {
      generatedAt: new Date().toISOString(), scanned: tasks.length,
    });
    const tmp = path.join(os.tmpdir(), "sas-e2e-report.html");
    fs.writeFileSync(tmp, html);
    assert.ok(html.includes("<table"), "report produced no table");
    assert.ok(!/\{(origin|date)\}/.test(html), "unfilled placeholder leaked into the report");
    console.log(`PASS  report rendered (${html.length} bytes) -> ${tmp}`);

    console.log("\nend-to-end OK");
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(`\nFAIL  ${e.message}`);
  process.exitCode = 1;
});

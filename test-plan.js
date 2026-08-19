"use strict";
/** Offline checks for lib/plan.js. Run: node test-plan.js */
const assert = require("assert");
const P = require("./lib/plan.js");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); pass++; }
  catch (e) { console.log(`FAIL  ${name}\n        -> ${e.message}`); fail++; }
}

check("dateRange is inclusive", () => {
  assert.deepStrictEqual(P.dateRange("2026-09-01", "2026-09-04"),
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
});

check("dateRange filters weekdays (Fri+Sun)", () => {
  const r = P.dateRange("2026-09-01", "2026-09-14", { weekdays: [5, 0] });
  assert.deepStrictEqual(r, ["2026-09-04", "2026-09-06", "2026-09-11", "2026-09-13"]);
});

check("dateRange rejects reversed range", () => {
  assert.throws(() => P.dateRange("2026-09-10", "2026-09-01"), /ends .* before/);
});

check("month-end and leap-year rollover", () => {
  assert.deepStrictEqual(P.dateRange("2028-02-27", "2028-03-01"),
    ["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
});

check("formatDate variants", () => {
  assert.strictEqual(P.formatDate("2026-09-04", ""), "2026-09-04");
  assert.strictEqual(P.formatDate("2026-09-04", "YYYYMMDD"), "20260904");
  assert.strictEqual(P.formatDate("2026-09-04", "DDMMYYYY"), "04092026");
});

check("fillTemplate substitutes and encodes", () => {
  const url = P.fillTemplate(
    "https://x/book?from={origin}&to={destination}&out={date:YYYYMMDD}&adt={adults}",
    { origin: "CPH", destination: "JFK", date: "2026-09-04", adults: 2 });
  assert.strictEqual(url, "https://x/book?from=CPH&to=JFK&out=20260904&adt=2");
});

check("fillTemplate reports unfilled placeholders", () => {
  assert.throws(() => P.fillTemplate("https://x?a={origin}&b={returnDate}", { origin: "CPH" }),
    /unfilled placeholder\(s\): returnDate/);
});

check("fillTemplate refuses empty template", () => {
  assert.throws(() => P.fillTemplate("", {}), /run `capture` first/);
});

check("booking horizon excludes past and >330 days", () => {
  const today = new Date(Date.UTC(2026, 7, 19));
  assert.strictEqual(P.withinHorizon("2026-08-18", today), false);
  assert.strictEqual(P.withinHorizon("2026-08-19", today), true);
  assert.strictEqual(P.withinHorizon("2027-07-15", today), true);
  assert.strictEqual(P.withinHorizon("2027-08-01", today), false);
});

check("buildPlan expands matrix and drops out-of-horizon dates", () => {
  const today = new Date(Date.UTC(2026, 7, 19));
  const { tasks, skipped } = P.buildPlan({
    origins: ["CPH"], destinations: ["JFK", "BKK"],
    dates: { from: "2027-07-14", to: "2027-07-16" }, adults: 1,
  }, { today });
  assert.strictEqual(tasks.length, 4, `expected 4 tasks, got ${tasks.length}`);
  assert.strictEqual(skipped.length, 2);
});

check("buildPlan skips origin==destination", () => {
  const today = new Date(Date.UTC(2026, 7, 19));
  const { tasks } = P.buildPlan({
    origins: ["CPH"], destinations: ["CPH", "OSL"],
    dates: { from: "2026-09-01", to: "2026-09-01" },
  }, { today });
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].destination, "OSL");
});

check("buildPlan derives returnDate across a month boundary", () => {
  const today = new Date(Date.UTC(2026, 7, 19));
  const { tasks } = P.buildPlan({
    origins: ["CPH"], destinations: ["JFK"],
    dates: { from: "2026-09-28", to: "2026-09-28" }, tripLengthDays: 7,
  }, { today });
  assert.strictEqual(tasks[0].returnDate, "2026-10-05");
});

check("normalizeCabin maps SAS brand names", () => {
  assert.strictEqual(P.normalizeCabin("SAS Go Smart"), "economy");
  assert.strictEqual(P.normalizeCabin("SAS Business"), "business");
  assert.strictEqual(P.normalizeCabin("Premium Economy"), "premium");
  assert.strictEqual(P.normalizeCabin("ECONOMY"), "economy");
  assert.strictEqual(P.normalizeCabin("wat"), null);
});

check("summarize flags saver vs dynamic against the route baseline", () => {
  const offers = [
    { origin: "CPH", destination: "JFK", date: "2026-09-14", cabin: "SAS Business", points: 60000 },
    { origin: "CPH", destination: "JFK", date: "2026-09-15", cabin: "SAS Business", points: 95000 },
    { origin: "CPH", destination: "JFK", date: "2026-09-16", cabin: "SAS Business", points: 60000 },
    { origin: "CPH", destination: "JFK", date: "2026-09-14", cabin: "SAS Go", points: 20000 },
  ];
  const s = P.summarize(offers);
  const biz = s.byDate.filter((r) => r.cabinNorm === "business");
  assert.strictEqual(biz.filter((r) => r.isSaver).length, 2);
  assert.strictEqual(biz.filter((r) => r.isPremium).length, 1);
  // Economy must be baselined separately, not against business.
  const eco = s.byDate.find((r) => r.cabinNorm === "economy");
  assert.strictEqual(eco.isSaver, true, "economy should baseline against economy");
});

check("recommend caps entries per route", () => {
  const offers = [];
  for (let d = 1; d <= 8; d++) {
    offers.push({ origin: "CPH", destination: "JFK", date: `2026-09-0${d}`, cabin: "Business", points: 60000 + d });
  }
  offers.push({ origin: "CPH", destination: "BKK", date: "2026-09-01", cabin: "Business", points: 61000 });
  const picks = P.recommend(P.summarize(offers), { limit: 10, perRoute: 3 });
  assert.strictEqual(picks.filter((p) => p.destination === "JFK").length, 3);
  assert.strictEqual(picks.filter((p) => p.destination === "BKK").length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

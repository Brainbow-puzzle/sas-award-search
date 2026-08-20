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


/* --------------------------------------------------- recipe selection */

const R = require("./lib/replay.js");

const dayRecipe   = { name: "search", urlTemplate: "/s?d={date:YYYY-MM-DD}", offersInCapture: 12 };
const dayRicher   = { name: "search2", urlTemplate: "/s2?d={date:YYYYMMDD}", offersInCapture: 40 };
const monthRecipe = { name: "calendar", urlTemplate: "/c?m={date:YYYY-MM}", offersInCapture: 300 };
const noneRecipe  = { name: "window", urlTemplate: "/w?o={origin}", offersInCapture: 50 };

check("granularity is read from the date format spec", () => {
  assert.strictEqual(R.dateGranularity(dayRecipe), "day");
  assert.strictEqual(R.dateGranularity(monthRecipe), "month");
  assert.strictEqual(R.dateGranularity(noneRecipe), "none");
});

check("selectRecipe defaults to the first recipe", () => {
  const s = R.selectRecipe([monthRecipe, dayRecipe]);
  assert.strictEqual(s.index, 0);
  assert.strictEqual(s.recipe.name, "calendar");
});

check("an explicit index beats a granularity request", () => {
  const s = R.selectRecipe([monthRecipe, dayRecipe], { index: 1, granularity: "month" });
  assert.strictEqual(s.index, 1);
  assert.strictEqual(s.recipe.name, "search");
});

check("--granularity=day picks a day recipe past a month one", () => {
  const s = R.selectRecipe([monthRecipe, dayRecipe], { granularity: "day" });
  assert.strictEqual(R.dateGranularity(s.recipe), "day");
  assert.strictEqual(s.recipe.name, "search");
});

check("--granularity=day prefers the richest day recipe", () => {
  const s = R.selectRecipe([monthRecipe, dayRecipe, dayRicher], { granularity: "day" });
  assert.strictEqual(s.recipe.name, "search2", "should take the one with more prices");
});

check("--granularity=month still reachable when day sorts first", () => {
  const s = R.selectRecipe([dayRecipe, monthRecipe], { granularity: "month" });
  assert.strictEqual(s.recipe.name, "calendar");
});

check("asking for a granularity that was not captured explains the fix", () => {
  assert.throws(
    () => R.selectRecipe([monthRecipe], { granularity: "day" }),
    /ONE specific date/,
    "should tell you to capture a single-date search",
  );
});

check("an out-of-range index is rejected", () => {
  assert.throws(() => R.selectRecipe([monthRecipe], { index: 5 }), /No recipe \[5\]/);
});

check("an unknown granularity is rejected", () => {
  assert.throws(() => R.selectRecipe([monthRecipe], { granularity: "hourly" }), /Unknown granularity/);
});

check("an empty recipe list points at capture", () => {
  assert.throws(() => R.selectRecipe([]), /capture/);
});

check("index 0 is honoured rather than treated as absent", () => {
  const s = R.selectRecipe([monthRecipe, dayRecipe], { index: 0, granularity: "day" });
  assert.strictEqual(s.index, 0, "explicit 0 must not fall through to granularity");
});

check("a bare --recipe flag is rejected rather than read as 1", () => {
  assert.throws(() => R.selectRecipe([monthRecipe, dayRecipe], { index: true }), /needs a number/);
});

/* ------------------------------------------- parameterize, on a real URL */

// SAS's date-picker endpoint, as captured from www.sas.dk. Two dates in one
// query string is the case that broke the per-parameter replacement order.
const SAS_URL = "https://www.sas.dk/bff/datepicker/flights/offers/v1" +
  "?market=dk-da&departureDate=2026-09-01&returnDate=2026-09-30&bookingFlow=points" +
  "&origin=CPH&destination=ARN&adult=1&child=0&infant=0&youth=0&tripType=RT";
const SAS_OBSERVED = { origin: "CPH", destination: "ARN", date: "2026-09-01", returnDate: "2026-09-30" };

check("a second date is not eaten by the first date's month form", () => {
  const t = R.parameterize(SAS_URL, SAS_OBSERVED);
  assert.ok(t.includes("returnDate={returnDate}"),
    `returnDate was mangled: ${t.match(/returnDate=[^&]*/)[0]}`);
  assert.ok(!t.includes("{date:YYYY-MM}-30"), "month form clobbered the return date");
});

check("both dates and both airports template out", () => {
  const t = R.parameterize(SAS_URL, SAS_OBSERVED);
  assert.ok(t.includes("departureDate={date}"), t);
  assert.ok(t.includes("origin={origin}"), t);
  assert.ok(t.includes("destination={destination}"), t);
});

check("non-varying query parameters survive untouched", () => {
  const t = R.parameterize(SAS_URL, SAS_OBSERVED);
  // bookingFlow=points is what makes the endpoint quote award prices at all.
  assert.ok(t.includes("bookingFlow=points"), "the points flag must not be templated away");
  assert.ok(t.includes("market=dk-da"), t);
  assert.ok(t.includes("tripType=RT"), t);
});

check("the templated URL re-materialises to the original", () => {
  const recipe = R.buildRecipe({ method: "GET", url: SAS_URL, headers: {}, postData: null },
    SAS_OBSERVED, { offersInCapture: 60 });
  const back = R.materialize(recipe.urlTemplate, SAS_OBSERVED);
  assert.strictEqual(back, SAS_URL, "round-trip must be lossless");
});

check("re-aiming the recipe swaps route and dates", () => {
  const recipe = R.buildRecipe({ method: "GET", url: SAS_URL, headers: {}, postData: null },
    SAS_OBSERVED, { offersInCapture: 60 });
  const out = R.materialize(recipe.urlTemplate,
    { origin: "ARN", destination: "BKK", date: "2026-11-01", returnDate: "2026-11-30" });
  assert.ok(out.includes("origin=ARN") && out.includes("destination=BKK"), out);
  assert.ok(out.includes("departureDate=2026-11-01"), out);
  assert.ok(out.includes("returnDate=2026-11-30"), out);
  assert.ok(!out.includes("2026-09"), "no September should survive re-aiming");
});

/* ------------------------------- evidence-based granularity, SAS date picker */

const sasRecipe = (datesInCapture) => R.buildRecipe(
  { method: "GET", url: SAS_URL, headers: {}, postData: null },
  SAS_OBSERVED, { offersInCapture: datesInCapture, datesInCapture });

check("a URL naming a full date is day-granularity when it returns one date", () => {
  assert.strictEqual(R.dateGranularity(sasRecipe(1)), "day");
});

check("the same URL is month-granularity when it returned a whole month", () => {
  // This is the real case: departureDate=2026-09-01 answers for all of September.
  assert.strictEqual(R.dateGranularity(sasRecipe(30)), "month");
});

check("the window threshold sits between a long weekend and a month", () => {
  assert.strictEqual(R.dateGranularity(sasRecipe(3)), "day", "3 dates is not a window");
  assert.strictEqual(R.dateGranularity(sasRecipe(7)), "month", "7 dates is");
});

check("a recipe with no capture evidence falls back to the URL shape", () => {
  const r = R.buildRecipe({ method: "GET", url: SAS_URL, headers: {}, postData: null },
    SAS_OBSERVED, {});
  assert.strictEqual(R.dateGranularity(r), "day");
});

check("--granularity=month now reaches the date picker recipe", () => {
  const s = R.selectRecipe([sasRecipe(30)], { granularity: "month" });
  assert.strictEqual(R.dateGranularity(s.recipe), "month");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

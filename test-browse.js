"use strict";
/**
 * Checks for the browsable page's question parser.
 *
 * It ships to the browser via toString(), so what is tested here is exactly
 * what runs there. The cases that matter are the ambiguous ones: a number that
 * could be points or hours, a city whose stored name is not what anyone types,
 * and a question it cannot answer — which must say so rather than silently
 * returning everything.
 *
 * Run: node test-browse.js
 */
const assert = require("assert");
const { parseAsk, cityAliases, fold, encode, buildBrowseHtml } = require("./lib/browse.js");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); pass++; }
  catch (e) { console.log(`FAIL  ${name}: ${e.message}`); fail++; }
}

const DATA = {
  home: "CPH",
  rows: [["CPH", "AGP", "2026-10-01", 9000, 284, 0, 0, 0]],
  places: {
    CPH: ["Copenhagen", "Denmark", "Nordics", ["city"], 0],
    AGP: ["Málaga", "Spain", "Southern Europe", ["beach"], 215],
    JFK: ["New York JFK", "United States", "North America", ["city"], 494],
    EWR: ["New York Newark", "United States", "North America", ["city"], 498],
    HER: ["Crete (Heraklion)", "Greece", "Southern Europe", ["beach"], 214],
    BKK: ["Bangkok", "Thailand", "Asia", ["city"], 678],
  },
};
const ask = (q) => parseAsk(q, DATA);

check("hours are read as hours, not as a points ceiling", () => {
  // "under 4" would otherwise set maxPoints=4000 and match nothing at all.
  const f = ask("cheapest beach under 4 hours").filters;
  assert.strictEqual(f.maxHours, 4);
  assert.strictEqual(f.maxPoints, undefined, "4 hours is not 4,000 points");
  assert.deepStrictEqual(f.tags, ["beach"]);
});

check("a points ceiling is read when no unit of time is present", () => {
  assert.strictEqual(ask("under 25000 points").filters.maxPoints, 25000);
  assert.strictEqual(ask("under 20k").filters.maxPoints, 20000);
  assert.strictEqual(ask("less than 30 thousand points").filters.maxPoints, 30000);
});

check("a bare small number is read as thousands", () => {
  // Nothing SAS sells costs twenty points.
  assert.strictEqual(ask("under 20").filters.maxPoints, 20000);
});

check("both a points and an hours limit survive together", () => {
  const f = ask("beach under 4 hours and under 20k").filters;
  assert.strictEqual(f.maxHours, 4);
  assert.strictEqual(f.maxPoints, 20000);
});

check("a month becomes a date range covering that whole month", () => {
  const f = ask("beach in october").filters;
  assert.strictEqual(f.from, "2026-10-01");
  assert.strictEqual(f.to, "2026-10-31", "October has 31 days");
});

check("a month with 30 days ends on the 30th", () => {
  assert.strictEqual(ask("september").filters.to, "2026-09-30");
});

check("a country is matched by name", () => {
  assert.strictEqual(ask("spain in september").filters.country, "spain");
});

check("a city matches every airport serving it", () => {
  const f = ask("new york in october").filters;
  assert.deepStrictEqual([...f.dests].sort(), ["EWR", "JFK"],
    "New York is two airports and both should match");
});

check("accents are optional, because nobody types them", () => {
  assert.deepStrictEqual(ask("malaga").filters.dests, ["AGP"]);
  assert.deepStrictEqual(ask("málaga").filters.dests, ["AGP"]);
});

check("a city stored with a qualifier answers to its plain name", () => {
  assert.deepStrictEqual(ask("crete").filters.dests, ["HER"]);
  assert.deepStrictEqual(ask("heraklion").filters.dests, ["HER"]);
});

check("the home airport is never read as a destination", () => {
  // Every row mentions it, so matching it would mean nothing.
  const f = ask("cheapest flights").filters;
  assert.strictEqual(f.dests, undefined);
});

check("returns are distinguished from outbound", () => {
  assert.strictEqual(ask("returns under 10000 points").filters.leg, "inbound");
  assert.strictEqual(ask("outbound only").filters.leg, "outbound");
  assert.strictEqual(ask("beach in may").filters.leg, undefined, "no leg means both");
});

check("weekdays and weekends are understood", () => {
  assert.deepStrictEqual(ask("beach on a friday").filters.weekdays, [5]);
  assert.deepStrictEqual(ask("weekends in july").filters.weekdays, [5, 6, 0]);
});

check("vague distance words map to bands", () => {
  assert.strictEqual(ask("somewhere short").filters.maxHours, 3.5);
  assert.strictEqual(ask("long haul beach").filters.minHours, 5);
});

check("what it cannot read is reported, not silently dropped", () => {
  const r = ask("somewhere warm with a hot tub and a spa");
  assert.deepStrictEqual(r.filters.tags, ["beach"], "warm is a beach hint");
  assert.ok(r.missed.includes("hot") && r.missed.includes("tub"),
    `expected the unread words back, got ${JSON.stringify(r.missed)}`);
});

check("an unreadable question reads as nothing rather than as everything", () => {
  const r = ask("qwerty zxcvb");
  assert.deepStrictEqual(r.filters, {});
  assert.ok(r.missed.length >= 2);
});

check("filler words are not reported as unread", () => {
  const r = ask("show me the cheapest flights to spain please");
  assert.deepStrictEqual(r.missed, [], `got ${JSON.stringify(r.missed)}`);
});

check("cityAliases covers qualifiers and parentheses", () => {
  assert.ok(cityAliases("New York JFK").includes("new york"));
  assert.ok(cityAliases("Crete (Heraklion)").includes("crete"));
  assert.ok(cityAliases("Crete (Heraklion)").includes("heraklion"));
});

check("fold preserves length, which the offset blanking depends on", () => {
  assert.strictEqual(fold("málaga"), "malaga");
  assert.strictEqual(fold("málaga").length, "málaga".length);
});

/* ---------------------------------------------------------------- the page */

const ROWS = [
  { origin: "CPH", destination: "AGP", depart_date: "2026-10-01", cabin: "economy",
    points: 9000, cash: 284, currency: "DKK", seats: null, direction: "outbound" },
  { origin: "AGP", destination: "CPH", depart_date: "2026-10-05", cabin: "economy",
    points: 9000, cash: 70, currency: "DKK", seats: null, direction: "inbound" },
];

check("encode keeps only the airports actually present", () => {
  const d = encode(ROWS, {});
  assert.deepStrictEqual(Object.keys(d.places).sort(), ["AGP", "CPH"]);
  assert.strictEqual(d.rows.length, 2);
  assert.strictEqual(d.rows[1][6], 1, "the return leg is flagged");
});

check("the page is one self-contained file with no external references", () => {
  const html = buildBrowseHtml(ROWS, {});
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(!/<script[^>]+src=/i.test(html), "no external scripts");
  assert.ok(!/<link[^>]+href=/i.test(html), "no external stylesheets");
  assert.ok(html.includes("AGP") && html.includes("9000"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

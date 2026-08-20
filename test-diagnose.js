"use strict";
/**
 * Tests for the offline capture post-mortem.
 *
 * The case that matters is the failing one: when the harvester reads nothing,
 * `diagnose` has to name the field that held the price. If that regresses, the
 * tool goes back to "no recognisable points data, good luck".
 *
 * Run: node test-diagnose.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { diagnose, analysePayload, nearMissNumbers, normalizePath } = require("./lib/diagnose.js");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); pass++; }
  catch (e) { console.log(`FAIL  ${name}: ${e.message}`); fail++; }
}

/** A payload the harvester understands: conventional key names. */
function readablePayload() {
  const days = [];
  for (let d = 1; d <= 10; d++) {
    days.push({
      date: `2026-10-${String(d).padStart(2, "0")}`,
      origin: { iata: "CPH" }, destination: { iata: "BKK" },
      cabins: [
        { cabin: "Economy", award: { points: 35000, tax: { amount: 41.5, currencyCode: "EUR" } }, seatsAvailable: 4 },
        { cabin: "Business", award: { points: 105000, tax: { amount: 88.0, currencyCode: "EUR" } }, seatsAvailable: 2 },
      ],
    });
  }
  return { calendar: { days } };
}

/** Same data, every key renamed — what a backend redesign looks like. */
function renamedPayload() {
  const results = [];
  for (let d = 1; d <= 8; d++) {
    results.push({
      legRef: { boardPoint: "CPH", offPoint: "BKK" },
      travelDay: `2026-10-${String(d).padStart(2, "0")}`,
      bookingClasses: [
        { marketingName: "SAS Go", redeemCost: { qty: 35000 }, surchargeDue: { sum: 41.5 }, inventoryLeft: 4 },
        { marketingName: "SAS Business", redeemCost: { qty: 105000 }, surchargeDue: { sum: 88.0 }, inventoryLeft: 2 },
      ],
    });
  }
  return { data: { awardSearch: { results } } };
}

check("normalizePath collapses array indices", () => {
  assert.strictEqual(normalizePath("data.results[3].fares[11].points"), "data.results[].fares[].points");
});

check("readable payload yields annotated offers", () => {
  const r = analysePayload({ url: "https://x/api/calendar", status: 200, json: readablePayload() });
  assert.ok(r.offers >= 20, `expected >=20 offers, got ${r.offers}`);
  assert.strictEqual(r.annotations.date, r.offers, "every offer should carry a date");
  assert.strictEqual(r.annotations.cabin, r.offers, "every offer should carry a cabin");
});

check("many distinct dates are flagged as calendar-style", () => {
  const r = analysePayload({ url: "https://x/api/calendar", json: readablePayload() });
  assert.strictEqual(r.calendarStyle, true);
  assert.strictEqual(r.dates.count, 10);
  assert.strictEqual(r.dates.first, "2026-10-01");
});

check("a single-date payload is not flagged as calendar-style", () => {
  const one = { date: "2026-10-01", cabin: "Economy", award: { points: 35000 } };
  const r = analysePayload({ url: "https://x/api/offers", json: one });
  assert.strictEqual(r.calendarStyle, false);
});

check("renamed schema yields no offers", () => {
  const r = analysePayload({ url: "https://x/graphql", json: renamedPayload() });
  assert.strictEqual(r.offers, 0, "renamed keys should defeat the harvester");
});

check("near-miss reporting names the field that held the price", () => {
  const r = analysePayload({ url: "https://x/graphql", json: renamedPayload() });
  const shapes = r.nearMisses.map((g) => g.shape);
  assert.ok(
    shapes.includes("data.awardSearch.results[].bookingClasses[].redeemCost.qty"),
    `price field not reported; got: ${shapes.join(", ") || "(none)"}`,
  );
});

check("near-miss samples show the actual values", () => {
  const g = nearMissNumbers(renamedPayload())
    .find((x) => x.shape.endsWith("redeemCost.qty"));
  assert.ok(g, "expected the redeemCost group");
  assert.ok(g.samples.includes(35000) && g.samples.includes(105000), `got samples ${g.samples}`);
  assert.strictEqual(g.count, 16, "8 dates x 2 cabins");
});

check("round numbers rank above arbitrary ones", () => {
  const json = { a: { serial: 60317, ref: 60317 }, b: { cost: 60000 } };
  const shapes = nearMissNumbers(json).map((g) => g.shape);
  assert.strictEqual(shapes[0], "b.cost", `expected the round number first, got ${shapes.join(", ")}`);
});

check("identifier-ish keys are filtered out of near misses", () => {
  const json = { bookingId: 123456, timestamp: 1780000, cost: 60000 };
  const shapes = nearMissNumbers(json).map((g) => g.shape);
  assert.ok(shapes.includes("cost"));
  assert.ok(!shapes.includes("bookingId"), "bookingId is noise");
  assert.ok(!shapes.includes("timestamp"), "timestamp is noise");
});

check("a missing date annotation is reported with candidate fields", () => {
  // Points and cabin readable, but the date hides under a key no matcher knows.
  const json = { rows: [{ travelDay: "2026-10-01", cabin: "Economy", award: { points: 35000 } }] };
  const r = analysePayload({ url: "https://x/api", json });
  assert.ok(r.offers > 0, "offers should still be found");
  assert.ok(r.missingAnnotations.date, "a date gap should be reported");
  const shapes = r.missingAnnotations.date.candidates.map((c) => c.shape);
  assert.ok(shapes.includes("rows[].travelDay"), `got ${shapes.join(", ")}`);
});

check("diagnose reads a directory and picks the best source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sas-diag-"));
  fs.writeFileSync(path.join(dir, "000_cal.json"),
    JSON.stringify({ url: "https://x/api/calendar", status: 200, json: readablePayload() }));
  fs.writeFileSync(path.join(dir, "001_gql.json"),
    JSON.stringify({ url: "https://x/graphql", status: 200, json: renamedPayload() }));
  const d = diagnose(dir);
  assert.strictEqual(d.payloads, 2);
  assert.strictEqual(d.usablePayloads, 1);
  assert.ok(d.best && d.best.url.includes("calendar"), "calendar payload should win");
  assert.strictEqual(d.best.calendarStyle, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

check("an unreadable file is reported, not thrown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sas-diag-"));
  fs.writeFileSync(path.join(dir, "000_broken.json"), "{not json");
  const d = diagnose(dir);
  assert.strictEqual(d.results.length, 1);
  assert.ok(d.results[0].error, "should carry an error rather than crash");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("a missing capture directory gives an actionable message", () => {
  assert.throws(() => diagnose("/nonexistent/captured"), /capture/i);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

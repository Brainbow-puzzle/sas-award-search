"use strict";
/**
 * Shape-independence check for lib/harvest.js.
 *
 * SAS's real payload shape is unknown and unstable, so the harvester is tested
 * against several deliberately different plausible shapes plus a decoy that
 * must yield nothing. Run: node test-harvest.js
 */
const { harvest, dedupe } = require("./lib/harvest.js");

const cases = {
  "flat offer list": {
    payload: { offers: [
      { origin: "CPH", destination: "JFK", departureDate: "2026-09-14T10:20:00",
        cabinClass: "BUSINESS", points: 60000, taxes: 412.5, currency: "DKK", seatsAvailable: 2 },
      { origin: "CPH", destination: "JFK", departureDate: "2026-09-15T10:20:00",
        cabinClass: "ECONOMY", points: 20000, taxes: 260, currency: "DKK", seatsAvailable: 6 },
    ] },
    expect: 2,
    require: { date: true, cabin: true, origin: true, cash: true },
  },
  "nested itinerary tree": {
    payload: { data: { itineraries: [ {
      from: { iata: "ARN" }, to: { iata: "CDG" },
      legs: [ { flightNumber: "SK1585", departure: { dateTime: "2026-10-02T07:05:00" } } ],
      products: [
        { brand: { name: "SAS Go Smart" }, award: { price: { pointsAmount: 9000 }, tax: { amount: 33.2, currencyCode: "EUR" } } },
        { brand: { name: "SAS Business" }, award: { price: { pointsAmount: 24000 }, tax: { amount: 41.0, currencyCode: "EUR" } } },
      ] } ] } },
    expect: 2,
    // Date lives on a sibling branch (legs[]) and cabin inside brand.name;
    // both must still be recovered.
    require: { date: true, cabin: true, origin: true, cash: true },
  },
  "calendar day grid": {
    payload: { calendar: { origin: "OSL", destination: "BKK", days: [
      { date: "2026-11-03", lowestAwardPrice: { miles: 35000 }, bookable: true },
      { date: "2026-11-04", lowestAwardPrice: { miles: 70000 }, bookable: true },
      { date: "2026-11-05", lowestAwardPrice: null, bookable: false },
    ] } },
    expect: 2,
    require: { date: true, origin: true },
  },
  "decoy (no award data)": {
    payload: { accountBalance: 182450, sessionId: 44, pageSize: 25, results: [] },
    expect: 0,
  },
};

let failures = 0;
for (const [name, { payload, expect, require: req }] of Object.entries(cases)) {
  const rows = dedupe(harvest(payload, { source: name }));
  const problems = [];
  if (rows.length !== expect) problems.push(`got ${rows.length} offers, expected ${expect}`);
  for (const field of Object.keys(req || {})) {
    const missing = rows.filter((r) => r[field] === null || r[field] === undefined);
    if (missing.length) problems.push(`${missing.length} row(s) missing "${field}"`);
  }
  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${rows.length} offer(s), expected ${expect}` +
    (problems.length ? `\n        -> ${problems.join("; ")}` : ""));
  for (const r of rows) {
    console.log(`        ${String(r.points).padStart(7)} pts | ${r.origin || "?"}->${r.destination || "?"} | ` +
      `${r.date || "?"} | ${r.cabin || "?"} | cash=${r.cash ?? "-"} ${r.currency || ""} | seats=${r.seats ?? "-"}`);
  }
}
console.log(failures ? `\n${failures} case(s) failed` : "\nall cases passed");
process.exit(failures ? 1 : 0);

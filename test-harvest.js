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
  // The real shape of www.sas.dk/bff/datepicker/flights/offers/v1, captured
  // 2026-08. Dates are object KEYS, not values, and the nested associatedFares
  // map pairs each outbound date with every possible return date. Reading dates
  // only from values yielded one undated row here, which `pull` then discarded.
  "SAS date picker: date-keyed maps": {
    payload: {
      currency: "DKK",
      outbound: {
        "2026-09-01": {
          totalPrice: 284, points: 10000, isStandardAward: true,
          associatedFares: {
            "2026-09-19": { totalPrice: 70, points: 10000, isStandardAward: true },
            "2026-09-20": { totalPrice: 70, points: 10000, isStandardAward: true },
          },
        },
        "2026-09-02": {
          totalPrice: 284, points: 10000, isStandardAward: true,
          associatedFares: {
            "2026-09-19": { totalPrice: 70, points: 10000, isStandardAward: true },
          },
        },
      },
      inbound: {
        "2026-09-19": { totalPrice: 70, points: 10000, isStandardAward: true },
      },
    },
    // Four distinct dates survive: the outbound 1st and 2nd, plus the 19th and
    // 20th reached through associatedFares. Points are identical throughout, so
    // dedupe collapses each date to a single row — which is the right answer for
    // "which dates have award space", the question this endpoint exists to serve.
    expect: 4,
    require: { date: true, cash: true },
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

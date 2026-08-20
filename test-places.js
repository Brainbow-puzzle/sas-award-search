"use strict";
/**
 * Checks for lib/places.js — the facts about destinations that SAS never sends.
 *
 * Flight times are derived from coordinates rather than typed in, so the tests
 * that matter compare the formula against published SAS block times. A drift
 * there means the banding is quietly lying about how far away somewhere is.
 *
 * Run: node test-places.js
 */
const assert = require("assert");
const P = require("./lib/places.js");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); pass++; }
  catch (e) { console.log(`FAIL  ${name}: ${e.message}`); fail++; }
}

check("a known airport resolves to city, country and region", () => {
  const p = P.place("AGP");
  assert.strictEqual(p.city, "Málaga");
  assert.strictEqual(p.country, "Spain");
  assert.strictEqual(p.cc, "ES");
  assert.strictEqual(p.region, "Southern Europe");
  assert.ok(p.tags.includes("beach"));
});

check("an unknown airport degrades instead of throwing", () => {
  const p = P.place("ZZZ");
  assert.strictEqual(p.known, false);
  assert.strictEqual(p.country, "Unknown");
  assert.strictEqual(p.hours, null);
  assert.strictEqual(p.band, "unknown");
  assert.deepStrictEqual(p.tags, []);
});

check("lookup is case-insensitive and survives junk", () => {
  assert.strictEqual(P.place("agp").country, "Spain");
  assert.strictEqual(P.place(null).known, false);
  assert.strictEqual(P.place("").known, false);
});

check("home airport is zero hours from itself", () => {
  assert.strictEqual(P.flightHours("CPH"), 0);
});

/**
 * Published SAS non-stop block times. The estimate models a great-circle
 * cruise, so it runs optimistic on very long sectors where real routings track
 * jetstreams — hence the wider tolerance beyond nine hours.
 */
check("derived flight times track published block times", () => {
  const published = {
    ARN: 1.17, LHR: 1.92, CDG: 1.83, AGP: 3.33,
    TFS: 5.58, JFK: 8.50, ORD: 9.00,
  };
  for (const [code, real] of Object.entries(published)) {
    const got = P.flightHours(code);
    const slack = real > 9 ? 1.5 : 0.5;
    assert.ok(Math.abs(got - real) <= slack,
      `${code}: computed ${got.toFixed(2)}h vs published ${real}h (allowed ±${slack})`);
  }
});

check("long-haul is estimated long even if not to the minute", () => {
  for (const code of ["BKK", "NRT", "SIN"]) {
    assert.ok(P.flightHours(code) > 9, `${code} should be over 9h`);
    assert.strictEqual(P.place(code).band, "over 9h");
  }
});

check("distance is symmetric and non-negative", () => {
  const a = P.AIRPORTS.CPH, b = P.AIRPORTS.JFK;
  assert.ok(Math.abs(P.distanceKm(a, b) - P.distanceKm(b, a)) < 1e-6);
  assert.ok(P.distanceKm(a, a) === 0);
});

check("duration bands are ordered and cover everything", () => {
  assert.strictEqual(P.durationBand(1.0), "under 2h");
  assert.strictEqual(P.durationBand(2.0), "under 2h", "boundary is inclusive");
  assert.strictEqual(P.durationBand(3.0), "2–3.5h");
  assert.strictEqual(P.durationBand(4.0), "3.5–5h");
  assert.strictEqual(P.durationBand(8.0), "5–9h");
  assert.strictEqual(P.durationBand(14.0), "over 9h");
  assert.strictEqual(P.durationBand(null), "unknown");
});

check("country matches by name or ISO code, case-insensitively", () => {
  assert.ok(P.matchesCountry("AGP", "Spain"));
  assert.ok(P.matchesCountry("AGP", "spain"));
  assert.ok(P.matchesCountry("AGP", "ES"));
  assert.ok(P.matchesCountry("AGP", "es"));
  assert.ok(!P.matchesCountry("AGP", "France"));
  assert.ok(P.matchesCountry("AGP", null), "no filter matches everything");
});

check("tags identify beach destinations", () => {
  for (const code of ["AGP", "PMI", "HER", "TFS", "HKT", "MLE", "CUN"]) {
    assert.ok(P.hasTag(code, "beach"), `${code} should be a beach destination`);
  }
  for (const code of ["ARN", "FRA", "BKK", "ORD"]) {
    assert.ok(!P.hasTag(code, "beach"), `${code} should not be tagged beach`);
  }
});

check("a place can carry several tags", () => {
  const bcn = P.place("BCN");
  assert.ok(bcn.tags.includes("beach") && bcn.tags.includes("city"),
    `BCN is both, got ${bcn.tags}`);
});

check("every airport has coordinates, a country and a known region", () => {
  for (const [code, a] of Object.entries(P.AIRPORTS)) {
    assert.ok(Number.isFinite(a.lat) && Math.abs(a.lat) <= 90, `${code} latitude`);
    assert.ok(Number.isFinite(a.lon) && Math.abs(a.lon) <= 180, `${code} longitude`);
    assert.ok(a.city && a.country && a.cc, `${code} is missing a name`);
    assert.notStrictEqual(P.place(code).region, "Unknown", `${code} has no region mapping`);
  }
});

check("tags are drawn from the documented vocabulary", () => {
  const allowed = new Set(["beach", "city", "ski", "nature"]);
  for (const [code, a] of Object.entries(P.AIRPORTS)) {
    for (const t of a.tags) assert.ok(allowed.has(t), `${code} has unknown tag "${t}"`);
  }
  assert.deepStrictEqual(P.allTags(), ["beach", "city", "nature", "ski"]);
});

check("southern beaches are further than Nordic cities", () => {
  // Guards against a sign error in a coordinate, which a spot check would miss.
  assert.ok(P.flightHours("AGP") > P.flightHours("ARN"));
  assert.ok(P.flightHours("TFS") > P.flightHours("AGP"));
  assert.ok(P.flightHours("BKK") > P.flightHours("TFS"));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

"use strict";
/**
 * Checks for lib/store.js, concentrating on the two things that silently lose
 * data: the direction column, and migrating a database that predates it.
 *
 * Run: node test-store.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { Store } = require("./lib/store.js");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); pass++; }
  catch (e) { console.log(`FAIL  ${name}: ${e.message}`); fail++; }
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sas-store-")), "a.db");

const out = (over = {}) => ({
  origin: "CPH", destination: "AGP", date: "2026-09-01", cabinNorm: "economy",
  points: 9000, cash: 284, currency: "DKK", direction: "outbound", ...over,
});
const back = (over = {}) => out({ origin: "AGP", destination: "CPH", cash: 70, direction: "inbound", ...over });

check("both legs of one date are stored, not collapsed", () => {
  const s = new Store(tmp());
  const { stored } = s.upsertOffers([out(), back()]);
  assert.strictEqual(stored, 2);
  assert.strictEqual(s.query({ limit: 10 }).length, 2);
  s.close();
});

check("direction round-trips and filters", () => {
  const s = new Store(tmp());
  s.upsertOffers([out(), back()]);
  const outs = s.query({ direction: "outbound", limit: 10 });
  const backs = s.query({ direction: "inbound", limit: 10 });
  assert.strictEqual(outs.length, 1);
  assert.strictEqual(backs.length, 1);
  assert.strictEqual(outs[0].destination, "AGP");
  assert.strictEqual(backs[0].origin, "AGP", "a return departs from the far end");
  s.close();
});

check("a row with no direction defaults to outbound", () => {
  const s = new Store(tmp());
  s.upsertOffers([out({ direction: undefined })]);
  assert.strictEqual(s.query({ limit: 1 })[0].direction, "outbound");
  s.close();
});

check("cheapestPerDestination reports outbound legs only", () => {
  const s = new Store(tmp());
  s.upsertOffers([out(), back()]);
  const rows = s.cheapestPerDestination({});
  assert.strictEqual(rows.length, 1, "home should not appear as a destination");
  assert.strictEqual(rows[0].destination, "AGP");
  s.close();
});

check("cheapestPerDestination can be asked for returns instead", () => {
  const s = new Store(tmp());
  s.upsertOffers([out(), back()]);
  const rows = s.cheapestPerDestination({ direction: "inbound" });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].destination, "CPH");
  s.close();
});

check("re-pulling stays idempotent with both legs present", () => {
  const s = new Store(tmp());
  s.upsertOffers([out(), back()]);
  s.upsertOffers([out(), back()]);
  assert.strictEqual(s.stats().offers, 2, "a second pull must refresh, not duplicate");
  s.close();
});

check("a database predating the direction column is migrated, not lost", () => {
  const p = tmp();
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE offers (origin TEXT NOT NULL, destination TEXT NOT NULL,
    depart_date TEXT NOT NULL, cabin TEXT NOT NULL, flight TEXT NOT NULL DEFAULT '',
    points INTEGER NOT NULL, cash REAL, currency TEXT, seats INTEGER, source TEXT,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
    PRIMARY KEY (origin, destination, depart_date, cabin, flight));
    CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL,
    destination TEXT NOT NULL, depart_date TEXT NOT NULL, cabin TEXT NOT NULL,
    flight TEXT NOT NULL DEFAULT '', points INTEGER NOT NULL, cash REAL, currency TEXT,
    seats INTEGER, seen_at TEXT NOT NULL);`);
  db.prepare("INSERT INTO offers VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("CPH", "JFK", "2026-10-01", "economy", "", 60000, 284, "DKK", null, "old", "2026-08-01", "2026-08-01");
  db.close();

  const s = new Store(p);
  const rows = s.query({ limit: 10 });
  assert.strictEqual(rows.length, 1, "the existing row must survive");
  assert.strictEqual(rows[0].points, 60000);
  assert.strictEqual(rows[0].direction, "outbound", "old rows were all outbound");
  // And the migrated table must still accept writes.
  s.upsertOffers([back()]);
  assert.strictEqual(s.stats().offers, 2);
  s.close();
});

check("migrating twice is harmless", () => {
  const p = tmp();
  new Store(p).close();
  const s = new Store(p);
  s.upsertOffers([out()]);
  assert.strictEqual(s.stats().offers, 1);
  s.close();
});

check("searchedSince reports only recent, productive searches", () => {
  const s = new Store(tmp());
  s.recordSearch({ origin: "CPH", destination: "AGP", from: "2026-09-01", to: "2026-09-30", offersFound: 60 });
  s.recordSearch({ origin: "CPH", destination: "JFK", from: "2026-09-01", to: "2026-09-30", offersFound: 0 });
  const done = s.searchedSince(24);
  assert.ok(done.has("CPH-AGP|2026-09-01"));
  assert.ok(!done.has("CPH-JFK|2026-09-01"), "a search that found nothing is worth retrying");
  s.close();
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

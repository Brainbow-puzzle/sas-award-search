"use strict";

/**
 * Local award-price database.
 *
 * The point of the tool is to pull data once and then interrogate it offline as
 * often as you like, so everything harvested lands here rather than in a
 * throwaway JSON blob.
 *
 * Three tables:
 *   offers       current best-known price per route/date/cabin/flight
 *   observations append-only log of every price ever seen, so you can tell
 *                whether something got cheaper rather than only what it costs now
 *   searches     which route/date windows were actually queried, so an absent
 *                row can be read as "no space" rather than "never looked"
 *
 * Uses node:sqlite (built in from Node 22), so there is no dependency to install.
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS offers (
  origin       TEXT NOT NULL,
  destination  TEXT NOT NULL,
  depart_date  TEXT NOT NULL,
  cabin        TEXT NOT NULL,
  flight       TEXT NOT NULL DEFAULT '',
  points       INTEGER NOT NULL,
  cash         REAL,
  currency     TEXT,
  seats        INTEGER,
  direction    TEXT NOT NULL DEFAULT 'outbound',
  source       TEXT,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  PRIMARY KEY (origin, destination, depart_date, cabin, flight)
);

CREATE TABLE IF NOT EXISTS observations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  origin       TEXT NOT NULL,
  destination  TEXT NOT NULL,
  depart_date  TEXT NOT NULL,
  cabin        TEXT NOT NULL,
  flight       TEXT NOT NULL DEFAULT '',
  points       INTEGER NOT NULL,
  cash         REAL,
  currency     TEXT,
  seats        INTEGER,
  direction    TEXT NOT NULL DEFAULT 'outbound',
  seen_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  origin       TEXT NOT NULL,
  destination  TEXT NOT NULL,
  window_from  TEXT NOT NULL,
  window_to    TEXT NOT NULL,
  recipe       TEXT,
  offers_found INTEGER NOT NULL DEFAULT 0,
  ran_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offers_route ON offers (origin, destination, cabin);
CREATE INDEX IF NOT EXISTS idx_offers_date  ON offers (depart_date);
CREATE INDEX IF NOT EXISTS idx_offers_pts   ON offers (points);
CREATE INDEX IF NOT EXISTS idx_obs_route    ON observations (origin, destination, depart_date, cabin);
`;

class Store {
  constructor(file) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  close() {
    this.db.close();
  }

  /**
   * Bring an existing database up to the current schema.
   *
   * CREATE TABLE IF NOT EXISTS silently leaves an older table alone, so a
   * column added later never appears in a database that already existed —
   * every query against it then fails on a machine that has pulled before.
   */
  migrate() {
    for (const table of ["offers", "observations"]) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes("direction")) {
        // Everything stored before this column existed was recorded as though it
        // flew outbound, which is what the old code assumed.
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound'`);
      }
    }
  }

  /**
   * Insert or refresh a batch of harvested offers. Rows missing the fields that
   * make an offer meaningful are dropped rather than stored as junk.
   */
  upsertOffers(rows, { now = new Date().toISOString() } = {}) {
    const insertOffer = this.db.prepare(`
      INSERT INTO offers (origin, destination, depart_date, cabin, flight, points,
                          cash, currency, seats, direction, source, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (origin, destination, depart_date, cabin, flight) DO UPDATE SET
        points    = excluded.points,
        cash      = COALESCE(excluded.cash, offers.cash),
        currency  = COALESCE(excluded.currency, offers.currency),
        seats     = COALESCE(excluded.seats, offers.seats),
        direction = excluded.direction,
        source    = COALESCE(excluded.source, offers.source),
        last_seen = excluded.last_seen
    `);
    const insertObs = this.db.prepare(`
      INSERT INTO observations (origin, destination, depart_date, cabin, flight,
                                points, cash, currency, seats, direction, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let stored = 0, skipped = 0;
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        if (!r.origin || !r.destination || !r.date || !r.points) { skipped++; continue; }
        const cabin = r.cabinNorm || r.cabin || "unknown";
        const flight = r.flight || "";
        const direction = r.direction === "inbound" ? "inbound" : "outbound";
        insertOffer.run(r.origin, r.destination, r.date, cabin, flight, r.points,
          r.cash ?? null, r.currency ?? null, r.seats ?? null, direction, r.source ?? null, now, now);
        insertObs.run(r.origin, r.destination, r.date, cabin, flight, r.points,
          r.cash ?? null, r.currency ?? null, r.seats ?? null, direction, now);
        stored++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { stored, skipped };
  }

  recordSearch({ origin, destination, from, to, recipe, offersFound }) {
    this.db.prepare(`
      INSERT INTO searches (origin, destination, window_from, window_to, recipe, offers_found, ran_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(origin, destination, from, to, recipe ?? null, offersFound ?? 0, new Date().toISOString());
  }

  /**
   * Free-form lookup over what has been pulled. All filters optional, which is
   * what makes this usable for "cheap business anywhere in March" as readily as
   * for one route.
   */
  query({
    origin = null, destination = null, cabin = null,
    maxPoints = null, minPoints = null,
    from = null, to = null, weekdays = null,
    maxCash = null, minSeats = null,
    saverOnly = false, order = "points", limit = 50, direction = null,
  } = {}) {
    const where = [];
    const params = [];
    const eq = (col, val) => { if (val) { where.push(`${col} = ?`); params.push(val); } };

    eq("origin", origin && origin.toUpperCase());
    eq("destination", destination && destination.toUpperCase());
    eq("cabin", cabin && cabin.toLowerCase());
    eq("direction", direction && direction.toLowerCase());
    if (maxPoints) { where.push("points <= ?"); params.push(Number(maxPoints)); }
    if (minPoints) { where.push("points >= ?"); params.push(Number(minPoints)); }
    if (from) { where.push("depart_date >= ?"); params.push(from); }
    if (to) { where.push("depart_date <= ?"); params.push(to); }
    if (maxCash !== null && maxCash !== undefined && maxCash !== false) {
      where.push("(cash IS NULL OR cash <= ?)"); params.push(Number(maxCash));
    }
    if (minSeats) { where.push("seats >= ?"); params.push(Number(minSeats)); }

    // SQLite's strftime('%w') gives 0=Sunday, matching the config convention.
    if (weekdays && weekdays.length) {
      where.push(`CAST(strftime('%w', depart_date) AS INTEGER) IN (${weekdays.map(() => "?").join(",")})`);
      params.push(...weekdays.map(Number));
    }

    // "Saver" = at the cheapest price ever seen for that route+cabin.
    const saverJoin = saverOnly
      ? `JOIN (SELECT origin o2, destination d2, cabin c2, MIN(points) best
               FROM offers GROUP BY origin, destination, cabin) b
           ON b.o2 = offers.origin AND b.d2 = offers.destination
          AND b.c2 = offers.cabin AND offers.points = b.best`
      : "";

    const orderBy = {
      points: "points ASC, depart_date ASC",
      date: "depart_date ASC, points ASC",
      cash: "COALESCE(cash, 0) ASC, points ASC",
      seats: "COALESCE(seats, 0) DESC, points ASC",
    }[order] || "points ASC, depart_date ASC";

    const sql = `SELECT offers.* FROM offers ${saverJoin}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${orderBy} LIMIT ?`;
    params.push(Number(limit) || 50);
    return this.db.prepare(sql).all(...params);
  }

  /** Cheapest option per destination — the "where can I go for the fewest points" view. */
  cheapestPerDestination({ origin = null, cabin = null, from = null, to = null,
    limit = 100, direction = "outbound" } = {}) {
    const where = [];
    const params = [];
    if (origin) { where.push("origin = ?"); params.push(origin.toUpperCase()); }
    if (cabin) { where.push("cabin = ?"); params.push(cabin.toLowerCase()); }
    // "Where can I go" is a question about outbound legs; returns land under
    // the home airport and would otherwise show up as a destination.
    if (direction) { where.push("direction = ?"); params.push(direction.toLowerCase()); }
    if (from) { where.push("depart_date >= ?"); params.push(from); }
    if (to) { where.push("depart_date <= ?"); params.push(to); }
    params.push(Number(limit) || 100);
    return this.db.prepare(`
      SELECT destination, cabin, MIN(points) AS points,
             COUNT(*) AS dates_available,
             MIN(depart_date) AS earliest, MAX(depart_date) AS latest
      FROM offers
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      GROUP BY destination, cabin
      ORDER BY points ASC
      LIMIT ?
    `).all(...params);
  }

  /** Per route+cabin saver baseline, used to classify a date as saver or not. */
  baselines() {
    return this.db.prepare(`
      SELECT origin, destination, cabin, MIN(points) AS points, COUNT(*) AS n
      FROM offers GROUP BY origin, destination, cabin ORDER BY points ASC
    `).all();
  }

  /** Prices that moved between observations — what got cheaper since last pull. */
  priceChanges({ limit = 50 } = {}) {
    return this.db.prepare(`
      SELECT origin, destination, depart_date, cabin,
             MIN(points) AS low, MAX(points) AS high,
             COUNT(DISTINCT points) AS distinct_prices,
             MIN(seen_at) AS first_seen, MAX(seen_at) AS last_seen
      FROM observations
      GROUP BY origin, destination, depart_date, cabin, flight
      HAVING distinct_prices > 1
      ORDER BY (high - low) DESC
      LIMIT ?
    `).all(Number(limit) || 50);
  }

  /**
   * Route+window pairs already queried within the last `hours`.
   *
   * A wide config is a thousand-request run, and a run that dies at request 700
   * should not start again from one. `searches` already records what was asked
   * and when, so resuming is a matter of reading it rather than new bookkeeping.
   */
  searchedSince(hours) {
    const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = this.db.prepare(
      "SELECT origin, destination, window_from FROM searches WHERE ran_at >= ? AND offers_found > 0",
    ).all(cutoff);
    return new Set(rows.map((r) => `${r.origin}-${r.destination}|${r.window_from}`));
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get();
    return {
      offers: one("SELECT COUNT(*) AS n FROM offers").n,
      observations: one("SELECT COUNT(*) AS n FROM observations").n,
      searches: one("SELECT COUNT(*) AS n FROM searches").n,
      routes: one("SELECT COUNT(*) AS n FROM (SELECT DISTINCT origin, destination FROM offers)").n,
      dateRange: one("SELECT MIN(depart_date) AS lo, MAX(depart_date) AS hi FROM offers"),
      lastPull: one("SELECT MAX(last_seen) AS t FROM offers").t,
    };
  }

  /** Everything, for the HTML report and for CSV export. */
  allOffers() {
    return this.db.prepare("SELECT * FROM offers ORDER BY origin, destination, cabin, depart_date").all();
  }
}

module.exports = { Store };

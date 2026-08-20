"use strict";

/**
 * Schema-agnostic extraction of award offers from arbitrary JSON.
 *
 * SAS's booking backend is private and its payload shape is not documented and
 * changes without notice, so this deliberately does not hardcode a schema.
 * Instead it walks any JSON value and reports every node that carries a
 * points-like number, annotated with the route/date/cabin context inherited
 * from its ancestors. That survives a backend rename that would break a
 * hand-written parser.
 */

/**
 * Key matching is token-based rather than substring-based. Splitting camelCase
 * and separators first means `pointsAmount` and `points_amount` both match
 * while `checkpoints` does not. (A `/[^a-z]/i` boundary would have been wrong:
 * the `i` flag makes that class exclude uppercase too, so it never fires on a
 * camelCase key.)
 */
function tokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

const POINTS_TOKEN = /^(points?|miles?|redemption)$/;

function isPointsKey(key) {
  const ts = tokens(key);
  if (ts.some((t) => POINTS_TOKEN.test(t))) return true;
  // "awardPrice", "award_cost", "lowestAwardPrice"
  const ai = ts.indexOf("award");
  return ai !== -1 && ts.slice(ai + 1).some((t) => /^(price|cost|amount|value)$/.test(t));
}
const CASH_KEY = /(tax|fee|surcharge|cash|amount|total|price)/i;
/** Narrower than CASH_KEY: only these name money the traveller actually pays. */
const TAX_KEY = /(tax|fee|surcharge)/i;
const CURRENCY_KEY = /currency|currencycode/i;
const DATE_KEY = /(date|departure|depart|arrival|arrive|time)/i;
const CABIN_KEY = /(cabin|travelclass|serviceclass|classofservice|fare(family|brand|name)?|brand|product)/i;
const ORIGIN_KEY = /(origin|from|departureairport|departurestation|source)/i;
const DEST_KEY = /(destination|to|arrivalairport|arrivalstation|dest)/i;
const FLIGHT_KEY = /(flightnumber|flightno|marketingflight|segmentnumber)/i;
const SEATS_KEY = /(seatsavailable|availableseats|seatsremaining|quota|inventory)/i;
const AVAIL_KEY = /(available|bookable|offered|saleable)/i;

const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})/;

/** Points values below this are almost certainly not an award price. */
const MIN_POINTS = 500;
/** Above this they are more likely an account balance or a byte count. */
const MAX_POINTS = 5000000;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Points are sometimes a bare number and sometimes wrapped
 * ({amount: 20000}, {value: 20000, unit: "POINTS"}). Accept both.
 */
function readNumeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value.trim());
  }
  if (isPlainObject(value)) {
    for (const k of ["amount", "value", "points", "miles", "quantity", "total"]) {
      if (k in value) {
        const n = readNumeric(value[k]);
        if (n !== null) return n;
      }
    }
  }
  return null;
}

function looksLikePoints(n) {
  return n !== null && n >= MIN_POINTS && n <= MAX_POINTS && Number.isInteger(n);
}

function firstDate(value) {
  if (typeof value !== "string") return null;
  const m = value.match(ISO_DATE);
  return m ? m[1] : null;
}

/**
 * Pull route/date/cabin hints for a node.
 *
 * Hints are read from the node's own scalar fields AND from a bounded scan of
 * its subtree, because real payloads scatter them: a departure date often
 * hangs under `legs[].departure.dateTime` while the price sits on a sibling
 * `products[]` branch, so ancestor-only inheritance would drop it. The depth
 * cap keeps this from degenerating into a full re-walk per node.
 */
const HINT_SCAN_DEPTH = 3;

function codeOf(value) {
  if (typeof value === "string" && IATA.test(value)) return value;
  if (isPlainObject(value)) {
    return [value.code, value.iata, value.iataCode, value.airportCode].find(
      (c) => typeof c === "string" && IATA.test(c),
    );
  }
  return undefined;
}

/** Cabin may be a string, or an object like {name: "SAS Business"}. */
function cabinOf(value) {
  if (typeof value === "string" && value.length <= 40 && !IATA.test(value)) return value;
  if (isPlainObject(value)) {
    const v = [value.name, value.code, value.description, value.title].find(
      (c) => typeof c === "string" && c.length <= 40,
    );
    return v;
  }
  return undefined;
}

function collectHints(node, ctx, depth) {
  if (depth > HINT_SCAN_DEPTH || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 12)) collectHints(item, ctx, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const scalar = typeof value === "string" || typeof value === "number";
    const code = codeOf(value);

    if (code && ORIGIN_KEY.test(key) && !DEST_KEY.test(key)) ctx.origin ??= code;
    else if (code && DEST_KEY.test(key)) ctx.destination ??= code;

    if (scalar && DATE_KEY.test(key)) {
      const d = firstDate(String(value));
      if (d) ctx.date ??= d;
    }
    if (CABIN_KEY.test(key)) {
      const c = cabinOf(value);
      if (c) ctx.cabin ??= c;
    }
    if (scalar && FLIGHT_KEY.test(key)) ctx.flight ??= String(value);
    if (typeof value === "string" && CURRENCY_KEY.test(key) && /^[A-Z]{3}$/.test(value)) {
      ctx.currency ??= value;
    }
    if (TAX_KEY.test(key) && !isPointsKey(key)) {
      const c = readNumeric(value);
      if (c !== null && c >= 0 && c < 100000) ctx.cash ??= c;
    }
    if (SEATS_KEY.test(key)) {
      const seats = readNumeric(value);
      if (seats !== null && seats >= 0 && seats < 100) ctx.seats ??= seats;
    }
    if (typeof value === "boolean" && AVAIL_KEY.test(key)) ctx.available ??= value;

    // Descend only into structure, never re-reading a scalar.
    if (value !== null && typeof value === "object") {
      collectHints(value, ctx, depth + 1);
    }
  }
}

function localContext(obj) {
  const ctx = {};
  collectHints(obj, ctx, 0);
  return ctx;
}

/**
 * Walk `root` and return every points-bearing node with its inherited context.
 * `path` entries are recorded so a later run can be turned into an exact
 * parser once the real shape is known.
 */
function harvest(root, { source = "" } = {}) {
  const found = [];
  const seen = new WeakSet();

  function walk(node, ctx, path, depth) {
    if (depth > 40 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, ctx, `${path}[${i}]`, depth + 1));
      return;
    }

    const nextCtx = { ...ctx, ...localContext(node) };

    for (const [key, value] of Object.entries(node)) {
      if (!isPointsKey(key)) continue;
      const n = readNumeric(value);
      if (!looksLikePoints(n)) continue;

      // Cash companion (taxes/fees) if this node carries one.
      let cash = null;
      for (const [k2, v2] of Object.entries(node)) {
        if (k2 === key || isPointsKey(k2)) continue;
        if (!CASH_KEY.test(k2)) continue;
        const c = readNumeric(v2);
        if (c !== null && c >= 0 && c < 100000) {
          cash = c;
          break;
        }
      }

      found.push({
        points: n,
        cash: cash ?? nextCtx.cash ?? null,
        currency: nextCtx.currency ?? null,
        origin: nextCtx.origin ?? null,
        destination: nextCtx.destination ?? null,
        date: nextCtx.date ?? null,
        cabin: nextCtx.cabin ?? null,
        flight: nextCtx.flight ?? null,
        seats: nextCtx.seats ?? null,
        available: nextCtx.available ?? null,
        pointsKey: key,
        path: `${path}.${key}`,
        source,
      });
    }

    for (const [key, value] of Object.entries(node)) {
      walk(value, nextCtx, path ? `${path}.${key}` : key, depth + 1);
    }
  }

  walk(root, {}, "", 0);
  return found;
}

/**
 * The walk is intentionally over-inclusive; one itinerary often yields the same
 * price via several nested nodes. Collapse to one row per
 * route+date+cabin+points, keeping the richest annotation.
 */
function dedupe(offers) {
  const byKey = new Map();
  for (const o of offers) {
    const key = [o.origin, o.destination, o.date, (o.cabin || "").toLowerCase(), o.points, o.flight].join("|");
    const prev = byKey.get(key);
    const score = (x) =>
      (x.date ? 1 : 0) + (x.cabin ? 1 : 0) + (x.origin ? 1 : 0) +
      (x.destination ? 1 : 0) + (x.cash !== null ? 1 : 0) + (x.seats !== null ? 1 : 0);
    if (!prev || score(o) > score(prev)) byKey.set(key, o);
  }
  return [...byKey.values()];
}

module.exports = {
  harvest, dedupe, looksLikePoints, readNumeric,
  // Exposed for `diagnose`, which reports what these did and did not match.
  isPointsKey,
  KEYS: { DATE_KEY, CABIN_KEY, ORIGIN_KEY, DEST_KEY, SEATS_KEY, TAX_KEY, CURRENCY_KEY, FLIGHT_KEY },
  LIMITS: { MIN_POINTS, MAX_POINTS },
};

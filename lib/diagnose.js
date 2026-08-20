"use strict";

/**
 * Offline post-mortem over the payloads `capture` already saved.
 *
 * `capture` needs a human driving a browser, so it is the one step that cannot be
 * automated or repeated cheaply. It is also the step most likely to disappoint:
 * if SAS's payload shape does not match what lib/harvest.js looks for, capture
 * reports "no recognisable points data" and leaves you to read raw JSON by hand.
 *
 * This module re-runs the harvester over out/captured/ instead — no browser and
 * no network — so tightening a matcher is a one-second loop rather than
 * another manual capture. When nothing is found it goes further and reports the
 * numbers the harvester *rejected*, with the key paths holding them, because
 * that is what tells you which matcher to widen.
 */

const fs = require("fs");
const path = require("path");
const { harvest, dedupe, isPointsKey, KEYS, LIMITS } = require("./harvest.js");

/** Collapse array indices so 50 sibling paths report as one shape. */
function normalizePath(p) {
  return p.replace(/\[\d+\]/g, "[]");
}

/**
 * Keys whose numbers are structural rather than commercial. Without this the
 * near-miss list drowns in identifiers, and the one field that actually held a
 * price scrolls off the top.
 *
 * Matching is token-based, so `bookingId` and `booking_id` are both filtered
 * while `totalAward` — a plausible price field — survives. Note what is
 * deliberately absent: `total`, `amount`, `cost`, `sum`, `value`. Those are
 * exactly where a renamed price hides, so they must never be treated as noise.
 */
const NOISE_TAIL = /^(id|uuid|guid|hash|index|idx|seq|sequence|offset|length|size|bytes|count|page|status|statuscode|version|revision|timestamp|epoch|millis|ms|zip|postal|lat|lon|latitude|longitude)$/;
const NOISE_ANY = /^(timestamp|epoch|millis|uuid|guid)$/;

function keyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function isNoiseKey(key) {
  const ts = keyTokens(key);
  if (!ts.length) return false;
  // The trailing token names what the number *is*: bookingId, legIndex, pageSize.
  if (NOISE_TAIL.test(ts[ts.length - 1])) return true;
  return ts.some((t) => NOISE_ANY.test(t));
}

/** Award charts deal in round numbers; 60000 is a likelier price than 60317. */
function roundness(n) {
  if (n % 5000 === 0) return 3;
  if (n % 1000 === 0) return 2;
  if (n % 100 === 0) return 1;
  return 0;
}

/**
 * Every integer in the plausible-points range that the harvester did NOT treat
 * as a price, grouped by the shape of the path holding it.
 */
function nearMissNumbers(root) {
  const groups = new Map();
  const seen = new WeakSet();

  function walk(node, p, depth) {
    if (depth > 40 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${p}[${i}]`, depth + 1));
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const child = p ? `${p}.${key}` : key;
      if (typeof value === "number" && Number.isInteger(value)) {
        const inRange = value >= LIMITS.MIN_POINTS && value <= LIMITS.MAX_POINTS;
        if (inRange && !isPointsKey(key) && !isNoiseKey(key)) {
          const shape = normalizePath(child);
          const g = groups.get(shape) || { shape, key, count: 0, samples: [] };
          g.count++;
          if (g.samples.length < 3 && !g.samples.includes(value)) g.samples.push(value);
          groups.set(shape, g);
        }
      }
      walk(value, child, depth + 1);
    }
  }

  walk(root, "", 0);

  return [...groups.values()].sort((a, b) => {
    const ar = Math.max(...a.samples.map(roundness));
    const br = Math.max(...b.samples.map(roundness));
    if (ar !== br) return br - ar;
    return b.count - a.count;
  });
}

/**
 * Candidate fields for an annotation the harvester failed to attach. A price
 * with no date is dropped by `pull` rather than guessed at, so knowing which
 * field held the date is what turns a silent 60% loss into a one-line fix.
 */
function annotationCandidates(root, kind) {
  const wanted = {
    date: (v) => typeof v === "string" && /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|\d{8}/.test(v),
    cabin: (v) => typeof v === "string" && v.length > 2 && v.length <= 40 && !/^\d+$/.test(v),
    route: (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v),
    seats: (v) => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100,
  }[kind];
  const alreadyMatched = {
    date: KEYS.DATE_KEY, cabin: KEYS.CABIN_KEY,
    route: new RegExp(`${KEYS.ORIGIN_KEY.source}|${KEYS.DEST_KEY.source}`, "i"),
    seats: KEYS.SEATS_KEY,
  }[kind];

  const groups = new Map();
  const seen = new WeakSet();

  function walk(node, p, depth) {
    if (depth > 40 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${p}[${i}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const child = p ? `${p}.${key}` : key;
      if (wanted(value) && !alreadyMatched.test(key)) {
        const shape = normalizePath(child);
        const g = groups.get(shape) || { shape, key, count: 0, samples: [] };
        g.count++;
        if (g.samples.length < 2 && !g.samples.includes(value)) g.samples.push(value);
        groups.set(shape, g);
      }
      walk(value, child, depth + 1);
    }
  }

  walk(root, "", 0);
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function largestInteger(root) {
  let max = null;
  const seen = new WeakSet();
  (function walk(node, depth) {
    if (depth > 40 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const value of Object.values(node)) {
      if (typeof value === "number" && Number.isInteger(value)) {
        if (max === null || value > max) max = value;
      } else walk(value, depth + 1);
    }
  })(root, 0);
  return max;
}

/** Analyse one saved capture file. Pure — no IO, so it is directly testable. */
function analysePayload(entry) {
  const json = entry.json ?? entry;
  const url = entry.url || "(unknown url)";
  const method = entry.request?.method || "GET";

  const offers = dedupe(harvest(json, { source: url }));
  const n = offers.length;
  const withField = (f) => offers.filter((o) => o[f] !== null && o[f] !== undefined).length;

  const dates = [...new Set(offers.map((o) => o.date).filter(Boolean))].sort();
  const result = {
    url, method, status: entry.status ?? null,
    offers: n,
    annotations: {
      date: withField("date"), cabin: withField("cabin"),
      origin: withField("origin"), destination: withField("destination"),
      cash: withField("cash"), seats: withField("seats"),
    },
    dates: { count: dates.length, first: dates[0] || null, last: dates[dates.length - 1] || null },
    // One request covering many dates is what makes a bulk pull cheap.
    calendarStyle: dates.length >= 7,
    nearMisses: [],
    missingAnnotations: {},
  };

  if (n === 0) {
    result.nearMisses = nearMissNumbers(json).slice(0, 8);
    result.largestInteger = largestInteger(json);
  } else {
    // Only report a gap that actually costs rows or filters.
    for (const kind of ["date", "cabin", "route", "seats"]) {
      const have = kind === "route" ? withField("destination") : withField(kind === "seats" ? "seats" : kind);
      if (have < n) {
        const cands = annotationCandidates(json, kind).slice(0, 4);
        if (cands.length) result.missingAnnotations[kind] = { have, of: n, candidates: cands };
      }
    }
  }
  return result;
}

/** Read every capture file in a directory, newest naming order preserved. */
function readCaptures(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(
      `No captured payloads at ${dir}.\n` +
      "Run `node search.js capture` first — it saves every JSON response it sees,\n" +
      "even when it cannot find prices in any of them.",
    );
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) throw new Error(`No .json files in ${dir}. Run \`node search.js capture\` first.`);
  return files.map((f) => {
    const full = path.join(dir, f);
    try {
      return { file: f, entry: JSON.parse(fs.readFileSync(full, "utf8")) };
    } catch (e) {
      return { file: f, error: e.message };
    }
  });
}

function diagnose(dir) {
  const captures = readCaptures(dir);
  const results = captures.map(({ file, entry, error }) =>
    error ? { file, error } : { file, ...analysePayload(entry) });

  const usable = results.filter((r) => !r.error && r.offers > 0);
  const totalOffers = usable.reduce((a, r) => a + r.offers, 0);
  return {
    dir,
    payloads: results.length,
    usablePayloads: usable.length,
    totalOffers,
    best: usable.slice().sort((a, b) => {
      if (a.calendarStyle !== b.calendarStyle) return a.calendarStyle ? -1 : 1;
      return b.offers - a.offers;
    })[0] || null,
    results,
  };
}

module.exports = { diagnose, analysePayload, nearMissNumbers, annotationCandidates, normalizePath };

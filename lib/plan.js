"use strict";

/**
 * Pure search-planning and ranking logic — no browser, no network, so it can be
 * unit-tested offline. lib/browser.js does the IO and hands results back here.
 */

/**
 * Checked most-specific first: "Premium Economy" must resolve to premium, not
 * economy. Single-letter booking codes are matched exactly rather than as
 * substrings, since a bare "y" appears inside plenty of unrelated words.
 */
const CABIN_MATCHERS = [
  { cabin: "first", words: ["first"], codes: ["f"] },
  { cabin: "business", words: ["business", "biz"], codes: ["c", "j", "d", "z"] },
  { cabin: "premium", words: ["premium", "plus"], codes: ["w", "e"] },
  { cabin: "economy", words: ["economy", "eco", "go"], codes: ["y", "m", "b"] },
];


function pad(n) {
  return String(n).padStart(2, "0");
}

function toISO(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Bad date "${s}" (expected YYYY-MM-DD)`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date "${s}"`);
  return d;
}

/** Inclusive date range, optionally filtered to given weekdays (0=Sun). */
function dateRange(from, to, { weekdays = null, everyNDays = 1 } = {}) {
  const start = parseISO(from);
  const end = parseISO(to);
  if (end < start) throw new Error(`Date range ends (${to}) before it starts (${from})`);
  const out = [];
  let i = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1), i++) {
    if (i % everyNDays !== 0) continue;
    if (weekdays && !weekdays.includes(d.getUTCDay())) continue;
    out.push(toISO(d));
  }
  return out;
}

/**
 * SAS releases award seats up to 330 days out; anything past that is a wasted
 * request, and anything in the past is a certain error.
 */
const BOOKING_HORIZON_DAYS = 330;

function withinHorizon(dateISO, today = new Date()) {
  const d = parseISO(dateISO);
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((d.getTime() - t) / 86400000);
  return days >= 0 && days <= BOOKING_HORIZON_DAYS;
}

function formatDate(dateISO, spec) {
  const [y, m, d] = dateISO.split("-");
  switch ((spec || "").toUpperCase()) {
    case "":
    case "YYYY-MM-DD": return dateISO;
    case "YYYYMMDD": return `${y}${m}${d}`;
    case "YYYY-MM": return `${y}-${m}`;
    case "YYYYMM": return `${y}${m}`;
    case "DDMMYYYY": return `${d}${m}${y}`;
    case "DD/MM/YYYY": return `${d}/${m}/${y}`;
    case "MM/DD/YYYY": return `${m}/${d}/${y}`;
    default: throw new Error(`Unknown date format "${spec}"`);
  }
}

/**
 * Fill {origin}, {destination}, {date}, {returnDate}, {adults} in a URL
 * template. Dates accept a format suffix, e.g. {date:YYYYMMDD}, because the
 * booking URL's date format is whatever `capture` observed on the real site.
 */
function fillTemplate(template, vars) {
  if (!template || typeof template !== "string") {
    throw new Error("No urlTemplate configured — run `capture` first.");
  }
  const unresolved = [];
  const filled = template.replace(/\{(\w+)(?::([^}]+))?\}/g, (whole, name, spec) => {
    const value = vars[name];
    if (value === undefined || value === null || value === "") {
      unresolved.push(name);
      return whole;
    }
    if (/^(date|returndate|outdate|indate|departuredate|returndate)$/i.test(name)) {
      return encodeURIComponent(formatDate(String(value), spec));
    }
    return encodeURIComponent(String(value));
  });
  if (unresolved.length) {
    throw new Error(`urlTemplate has unfilled placeholder(s): ${[...new Set(unresolved)].join(", ")}`);
  }
  return filled;
}

/** Build the full origin x destination x date task list. */
function buildPlan(config, { today = new Date() } = {}) {
  const origins = [].concat(config.origins || []);
  const destinations = [].concat(config.destinations || []);
  if (!origins.length) throw new Error("config.origins is empty");
  if (!destinations.length) throw new Error("config.destinations is empty");

  const dates = dateRange(config.dates.from, config.dates.to, {
    weekdays: config.dates.weekdays ?? null,
    everyNDays: config.dates.everyNDays ?? 1,
  });

  const tasks = [];
  const skipped = [];
  for (const origin of origins) {
    for (const destination of destinations) {
      if (origin === destination) continue;
      for (const date of dates) {
        if (!withinHorizon(date, today)) {
          skipped.push({ origin, destination, date, reason: "outside 330-day booking horizon" });
          continue;
        }
        const returnDate = config.tripLengthDays
          ? toISO(new Date(parseISO(date).getTime() + config.tripLengthDays * 86400000))
          : null;
        tasks.push({ origin, destination, date, returnDate, adults: config.adults || 1 });
      }
    }
  }
  return { tasks, dates, skipped };
}

function normalizeCabin(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  for (const { cabin, codes } of CABIN_MATCHERS) {
    if (codes.includes(s)) return cabin;
  }
  for (const { cabin, words } of CABIN_MATCHERS) {
    if (words.some((w) => s.includes(w))) return cabin;
  }
  return null;
}

/**
 * SAS prices most awards from a fixed zone/cabin chart, so the interesting
 * signal is not "which date is cheapest" in a smooth sense — it is which dates
 * have saver space at the chart price versus a dynamic price well above it.
 * Baseline = the cheapest points seen for that route+cabin across the scan;
 * anything at baseline is flagged as the good price.
 */
function summarize(offers, { premiumThreshold = 1.25 } = {}) {
  const rows = offers
    .filter((o) => o.points && o.date)
    .map((o) => ({ ...o, cabinNorm: normalizeCabin(o.cabin) }));

  const baselines = new Map();
  for (const r of rows) {
    const key = `${r.origin || "?"}|${r.destination || "?"}|${r.cabinNorm || "?"}`;
    const cur = baselines.get(key);
    if (cur === undefined || r.points < cur) baselines.set(key, r.points);
  }

  const annotated = rows.map((r) => {
    const key = `${r.origin || "?"}|${r.destination || "?"}|${r.cabinNorm || "?"}`;
    const baseline = baselines.get(key);
    const ratio = baseline ? r.points / baseline : 1;
    return { ...r, baseline, ratio, isSaver: ratio <= 1.0001, isPremium: ratio >= premiumThreshold };
  });

  // Cheapest offer per route+cabin+date, which is what a calendar view wants.
  const best = new Map();
  for (const r of annotated) {
    const key = `${r.origin || "?"}|${r.destination || "?"}|${r.cabinNorm || "?"}|${r.date}`;
    const cur = best.get(key);
    if (!cur || r.points < cur.points) best.set(key, r);
  }

  return {
    all: annotated,
    byDate: [...best.values()].sort((a, b) => a.points - b.points || a.date.localeCompare(b.date)),
    baselines: [...baselines.entries()].map(([key, points]) => {
      const [origin, destination, cabin] = key.split("|");
      return { origin, destination, cabin, points };
    }),
  };
}

/** Top N cheapest, one entry per route+cabin so a single route can't fill the list. */
function recommend(summary, { limit = 20, perRoute = 3 } = {}) {
  const counts = new Map();
  const picks = [];
  for (const r of summary.byDate) {
    const key = `${r.origin}|${r.destination}|${r.cabinNorm}`;
    const n = counts.get(key) || 0;
    if (n >= perRoute) continue;
    counts.set(key, n + 1);
    picks.push(r);
    if (picks.length >= limit) break;
  }
  return picks;
}

module.exports = {
  dateRange, parseISO, toISO, formatDate, fillTemplate, buildPlan,
  withinHorizon, normalizeCabin, summarize, recommend, BOOKING_HORIZON_DAYS,
};

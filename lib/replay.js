"use strict";

/**
 * Request replay — the efficient way to pull award data.
 *
 * Loading a full booking page per date is slow and heavy. Once `capture` has
 * seen which request actually returns prices, that request can be re-issued
 * directly with different parameters, reusing the logged-in session. One HTTP
 * call instead of a page render, and if the captured request was a
 * flexible-date/calendar query it returns a whole month at a time.
 *
 * A "recipe" is a captured request turned into a template: the origin,
 * destination and dates that appeared in its URL and body are swapped for
 * placeholders, so the same request can be re-aimed anywhere.
 */

const { formatDate } = require("./plan.js");

/** Headers that must not be replayed verbatim: the client recomputes them. */
const DROP_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive", "transfer-encoding",
  "upgrade", "proxy-authorization", "proxy-connection", "te", "trailer",
  ":method", ":path", ":scheme", ":authority",
  "accept-encoding", "cookie", // cookies come from the browser context
]);

function cleanHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (DROP_HEADERS.has(k.toLowerCase())) continue;
    if (k.startsWith(":")) continue;
    out[k] = v;
  }
  return out;
}

/** Every way a given ISO date might appear in a request. Longest first so a
 *  replacement never eats part of another format. */
function dateVariants(iso) {
  // Month forms are included because calendar endpoints are usually addressed by
  // month; they sort last by length so a full date is always consumed first.
  const specs = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "YYYYMMDD", "DDMMYYYY",
                 "YYYY-MM", "YYYYMM"];
  return specs
    .map((spec) => ({ spec, text: formatDate(iso, spec) }))
    .sort((a, b) => b.text.length - a.text.length);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the concrete values of one observed search with placeholders.
 * Literal substitution of values the user confirms they searched for, rather
 * than guessing which field means what — a guess that misfires produces
 * requests that silently return the wrong thing.
 */
function parameterize(text, observed) {
  if (typeof text !== "string" || !text) return text;
  let out = text;

  // Dates first: an unanchored 3-letter code could otherwise match inside one.
  for (const [name, iso] of [["date", observed.date], ["returnDate", observed.returnDate]]) {
    if (!iso) continue;
    for (const { spec, text: variant } of dateVariants(iso)) {
      const placeholder = spec === "YYYY-MM-DD" ? `{${name}}` : `{${name}:${spec}}`;
      out = out.replace(new RegExp(escapeRe(variant), "g"), placeholder);
    }
  }

  for (const [name, code] of [["origin", observed.origin], ["destination", observed.destination]]) {
    if (!code) continue;
    // Word-bounded so CPH inside a longer token is left alone.
    out = out.replace(new RegExp(`\\b${escapeRe(code)}\\b`, "g"), `{${name}}`);
  }
  return out;
}

/** Substitute real values back into a parameterized string. */
function materialize(template, vars) {
  if (typeof template !== "string" || !template) return template;
  const missing = new Set();
  const out = template.replace(/\{(origin|destination|date|returnDate|adults)(?::([^}]+))?\}/g,
    (whole, name, spec) => {
      const value = vars[name];
      if (value === undefined || value === null || value === "") { missing.add(name); return whole; }
      if (name === "date" || name === "returnDate") return formatDate(String(value), spec || "");
      return String(value);
    });
  if (missing.size) {
    throw new Error(`recipe needs ${[...missing].join(", ")} but the task did not supply it`);
  }
  return out;
}

/**
 * Turn a captured request into a reusable recipe.
 * `observed` describes the search the user actually ran during capture.
 */
function buildRecipe(request, observed, meta = {}) {
  return {
    name: meta.name || new URL(request.url).pathname.split("/").filter(Boolean).slice(-2).join("/"),
    method: request.method || "GET",
    urlTemplate: parameterize(request.url, observed),
    bodyTemplate: parameterize(request.postData || "", observed) || null,
    headers: cleanHeaders(request.headers),
    observed,
    offersInCapture: meta.offersInCapture ?? null,
    // A recipe whose URL or body still mentions a date can be re-aimed at other
    // dates; one that mentions none probably returned a whole calendar window.
    parameters: [...new Set(
      ((parameterize(request.url, observed) + (parameterize(request.postData || "", observed) || ""))
        .match(/\{(origin|destination|date|returnDate)(?::[^}]+)?\}/g) || [])
        // Strip the format spec before deduping: {date} and {date:YYYYMMDD}
        // are the same parameter appearing in two encodings.
        .map((m) => m.replace(/[{}]/g, "").split(":")[0]),
    )],
  };
}

const DAY_SPECS = new Set(["", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "YYYYMMDD", "DDMMYYYY"]);

/**
 * How finely a recipe must be iterated:
 *   "day"   — it names a specific date, so one request per date
 *   "month" — it names only a month, so one request covers that whole month
 *   "none"  — no date at all, so one request covers the endpoint's own window
 *
 * This is the difference between 700 requests and 20.
 */
function dateGranularity(recipe) {
  const text = `${recipe.urlTemplate || ""}${recipe.bodyTemplate || ""}`;
  const specs = [...text.matchAll(/\{date(?::([^}]+))?\}/g)].map((m) => m[1] || "");
  if (!specs.length) return "none";
  return specs.some((sp) => DAY_SPECS.has(sp)) ? "day" : "month";
}

function needsDate(recipe) {
  return dateGranularity(recipe) === "day";
}

/**
 * Issue one recipe against a live authenticated context.
 * `ctx` is a Playwright APIRequestContext (context.request), which carries the
 * browser's cookies — so this is the logged-in session making the same call the
 * page itself makes.
 */
async function replay(ctx, recipe, vars, { timeout = 30000 } = {}) {
  const url = materialize(recipe.urlTemplate, vars);
  const body = recipe.bodyTemplate ? materialize(recipe.bodyTemplate, vars) : null;

  const options = { headers: recipe.headers, timeout, failOnStatusCode: false };
  if (body !== null && recipe.method !== "GET" && recipe.method !== "HEAD") {
    options.data = body;
  }

  const res = await ctx.fetch(url, { method: recipe.method, ...options });
  const status = res.status();
  let json = null;
  let text = "";
  try {
    text = await res.text();
    json = JSON.parse(text);
  } catch {
    // Non-JSON means the session probably lapsed and we were handed a login page.
  }
  return { status, json, url, bodyLength: text.length };
}

module.exports = {
  parameterize, materialize, buildRecipe, replay, needsDate, dateGranularity,
  cleanHeaders, dateVariants,
};

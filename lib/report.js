"use strict";

/**
 * Console + standalone HTML reporting.
 *
 * The HTML report is a single self-contained file (no assets, no network) so it
 * can be opened straight from disk or mailed to someone.
 */

const CABIN_ORDER = ["economy", "premium", "business", "first"];

function fmtPoints(n) {
  return n.toLocaleString("en-GB");
}

function fmtCash(row) {
  if (row.cash === null || row.cash === undefined) return "";
  return `+${row.cash.toLocaleString("en-GB", { maximumFractionDigits: 0 })} ${row.currency || ""}`.trim();
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function weekdayOf(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function printConsole(summary, picks, { scanned = 0 } = {}) {
  if (!summary.byDate.length) {
    console.log("\nNo award offers were found. See the troubleshooting section in README.md.");
    return;
  }

  console.log(`\nBaseline (cheapest seen) per route and cabin — the saver price:`);
  for (const b of summary.baselines.sort((a, c) => a.points - c.points)) {
    console.log(`  ${b.origin}->${b.destination}  ${String(b.cabin).padEnd(9)} ${fmtPoints(b.points).padStart(9)} pts`);
  }

  console.log(`\nBest ${picks.length} option(s) across ${scanned} searched date(s):`);
  console.log(`  ${"DATE".padEnd(12)}${"".padEnd(5)}${"ROUTE".padEnd(10)}${"CABIN".padEnd(10)}${"POINTS".padStart(9)}  TAXES`);
  for (const r of picks) {
    const flag = r.isSaver ? "saver" : r.isPremium ? "HIGH" : "";
    console.log(
      `  ${r.date.padEnd(12)}${weekdayOf(r.date).padEnd(5)}` +
      `${`${r.origin || "?"}-${r.destination || "?"}`.padEnd(10)}` +
      `${(r.cabinNorm || "?").padEnd(10)}${fmtPoints(r.points).padStart(9)}  ` +
      `${fmtCash(r).padEnd(14)}${flag}`,
    );
  }
}

/** Group rows into route+cabin -> date -> row, for the calendar grid. */
function grid(summary) {
  const groups = new Map();
  for (const r of summary.byDate) {
    const key = `${r.origin || "?"}-${r.destination || "?"}|${r.cabinNorm || "?"}`;
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(r.date, r);
  }
  return groups;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function buildHtml(summary, picks, meta = {}) {
  const groups = grid(summary);
  const allDates = [...new Set(summary.byDate.map((r) => r.date))].sort();

  const groupHtml = [...groups.entries()]
    .sort((a, b) => {
      const ca = CABIN_ORDER.indexOf(a[0].split("|")[1]);
      const cb = CABIN_ORDER.indexOf(b[0].split("|")[1]);
      return a[0].localeCompare(b[0]) && ca - cb || a[0].localeCompare(b[0]);
    })
    .map(([key, byDate]) => {
      const [route, cabin] = key.split("|");
      const baseline = Math.min(...[...byDate.values()].map((r) => r.points));
      const cells = allDates.map((d) => {
        const r = byDate.get(d);
        if (!r) return `<td class="cell none" title="${esc(d)}: not searched / no space"></td>`;
        const cls = r.isSaver ? "saver" : r.isPremium ? "high" : "mid";
        const tip = `${d} ${weekdayOf(d)} — ${fmtPoints(r.points)} pts${r.cash != null ? ` + ${r.cash} ${r.currency || ""}` : ""}${r.seats != null ? ` — ${r.seats} seat(s)` : ""}`;
        return `<td class="cell ${cls}" title="${esc(tip)}"><span class="pts">${fmtPoints(r.points)}</span></td>`;
      }).join("");
      return `<section class="group">
  <h3>${esc(route)} <span class="cabin">${esc(cabin)}</span> <span class="base">saver ${fmtPoints(baseline)} pts</span></h3>
  <div class="scroll"><table><thead><tr>${allDates.map((d) => `<th><span>${esc(d.slice(5))}</span><em>${weekdayOf(d)}</em></th>`).join("")}</tr></thead>
  <tbody><tr>${cells}</tr></tbody></table></div>
</section>`;
    }).join("\n");

  const pickRows = picks.map((r) => `<tr>
  <td>${esc(r.date)} <em>${weekdayOf(r.date)}</em></td>
  <td>${esc(r.origin || "?")} &rarr; ${esc(r.destination || "?")}</td>
  <td>${esc(r.cabinNorm || "?")}</td>
  <td class="num"><strong>${fmtPoints(r.points)}</strong></td>
  <td class="num">${esc(fmtCash(r))}</td>
  <td>${r.isSaver ? '<span class="tag saver">saver</span>' : r.isPremium ? '<span class="tag high">above saver</span>' : ""}</td>
</tr>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SAS EuroBonus award scan</title>
<style>
  :root {
    --bg: #ffffff; --fg: #14161a; --muted: #5c6470; --line: #e3e6ea; --panel: #f7f8fa;
    --saver: #1a7f4b; --saver-bg: #e6f4ec; --mid: #8a6d1f; --mid-bg: #fbf3dd;
    --high: #a63329; --high-bg: #fbe9e7; --none: #f0f1f3;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #14161a; --fg: #e9ecef; --muted: #9aa3af; --line: #2a2f37; --panel: #1b1e24;
      --saver: #6fd39b; --saver-bg: #143026; --mid: #e0c060; --mid-bg: #332b12;
      --high: #f08a7e; --high-bg: #3a1d1a; --none: #22262d;
    }
  }
  :root[data-theme="dark"] {
    --bg: #14161a; --fg: #e9ecef; --muted: #9aa3af; --line: #2a2f37; --panel: #1b1e24;
    --saver: #6fd39b; --saver-bg: #143026; --mid: #e0c060; --mid-bg: #332b12;
    --high: #f08a7e; --high-bg: #3a1d1a; --none: #22262d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .meta { color: var(--muted); font-size: .875rem; margin-bottom: 2rem; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .75rem; }
  h3 { font-size: .95rem; margin: 0 0 .5rem; font-weight: 600; }
  .cabin { color: var(--muted); font-weight: 500; }
  .base { float: right; color: var(--saver); font-weight: 600; font-size: .85rem; }
  table { border-collapse: collapse; width: 100%; }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
  .group { margin-bottom: 1.75rem; }
  th { font-weight: 500; font-size: .7rem; color: var(--muted); padding: .4rem .3rem;
    border-bottom: 1px solid var(--line); white-space: nowrap; }
  th span { display: block; } th em { font-style: normal; opacity: .7; }
  .cell { padding: .55rem .4rem; text-align: center; font-size: .78rem; white-space: nowrap;
    border-right: 1px solid var(--line); }
  .cell.saver { background: var(--saver-bg); color: var(--saver); font-weight: 700; }
  .cell.mid { background: var(--mid-bg); color: var(--mid); }
  .cell.high { background: var(--high-bg); color: var(--high); }
  .cell.none { background: var(--none); }
  .picks { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .picks table { table-layout: auto; }
  .picks td { padding: .55rem .7rem; border-bottom: 1px solid var(--line); font-size: .875rem;
    white-space: nowrap; width: 1%; }
  .picks td:last-child { width: auto; }
  .picks tr:last-child td { border-bottom: 0; }
  .picks .num { text-align: right; font-variant-numeric: tabular-nums; }
  .picks em { font-style: normal; color: var(--muted); }
  .tag { font-size: .7rem; padding: .1rem .45rem; border-radius: 999px; font-weight: 600; }
  .tag.saver { background: var(--saver-bg); color: var(--saver); }
  .tag.high { background: var(--high-bg); color: var(--high); }
  .legend { display: flex; gap: 1rem; flex-wrap: wrap; font-size: .8rem; color: var(--muted); margin: .75rem 0 0; }
  .swatch { display: inline-block; width: .8rem; height: .8rem; border-radius: 3px; vertical-align: -1px; margin-right: .3rem; }
  .note { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: .85rem 1rem; font-size: .85rem; color: var(--muted); margin-top: 2.5rem; }
</style></head>
<body><div class="wrap">
<h1>SAS EuroBonus award scan</h1>
<div class="meta">${esc(fmtWhen(meta.generatedAt))} &middot; ${esc(String(meta.scanned || 0))} date-searches &middot;
${esc(String(summary.byDate.length))} priced results</div>

<h2>Best options</h2>
<div class="picks"><table><tbody>${pickRows || '<tr><td>No results.</td></tr>'}</tbody></table></div>

<h2>Calendar</h2>
${groupHtml || "<p>No results.</p>"}
<div class="legend">
  <span><i class="swatch" style="background:var(--saver-bg);border:1px solid var(--saver)"></i>saver — the chart price</span>
  <span><i class="swatch" style="background:var(--mid-bg);border:1px solid var(--mid)"></i>above saver</span>
  <span><i class="swatch" style="background:var(--high-bg);border:1px solid var(--high)"></i>well above saver</span>
  <span><i class="swatch" style="background:var(--none)"></i>no award space found</span>
</div>

<div class="note">SAS prices most awards from a fixed zone/cabin chart, so the number rarely
drifts by a few points from day to day — a date is either at the saver price or it is not.
Blank cells mean no award space was returned for that search, which is the usual reason a
date is unavailable rather than merely expensive. Taxes and carrier fees are shown separately
and are paid in cash. Verify every price on flysas.com before booking.</div>
</div></body></html>`;
}

module.exports = { printConsole, buildHtml, weekdayOf, fmtWhen };

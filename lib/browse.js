"use strict";

/**
 * The browsable report: one self-contained HTML file, no assets and no network.
 *
 * Everything the page needs is embedded, so it opens from disk and keeps
 * working on a plane. That is also why filtering happens in the browser rather
 * than by regenerating: the point of pulling once is to interrogate the result
 * as often as you like without asking SAS anything again.
 *
 * Rows are encoded as arrays rather than objects. A full pull is tens of
 * thousands of rows, and repeating six key names on each one roughly triples
 * the file for no benefit — the decoder on the other side is four lines.
 */

const places = require("./places.js");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Pack the rows and everything needed to describe them.
 *
 * Only airports that actually appear are included, so the place table costs
 * nothing for a narrow pull.
 */
function encode(rows, meta) {
  const codes = new Set();
  for (const r of rows) { codes.add(r.origin); codes.add(r.destination); }

  const placeMap = {};
  for (const code of codes) {
    const p = places.place(code);
    placeMap[code] = [p.city, p.country, p.region, p.tags, p.hours === null ? null : Math.round(p.hours * 60)];
  }

  // origin, destination, date, points, cash, currency, direction, cabin
  const currencies = [...new Set(rows.map((r) => r.currency || ""))];
  const cabins = [...new Set(rows.map((r) => r.cabin || "unknown"))];
  const packed = rows.map((r) => [
    r.origin, r.destination, r.depart_date, r.points,
    r.cash === null || r.cash === undefined ? null : Math.round(r.cash),
    currencies.indexOf(r.currency || ""),
    r.direction === "inbound" ? 1 : 0,
    cabins.indexOf(r.cabin || "unknown"),
  ]);

  return { generatedAt: meta.generatedAt || new Date().toISOString(), home: places.HOME,
    currencies, cabins, places: placeMap, rows: packed };
}

const STYLE = `
:root{color-scheme:light dark;
  --bg:#f6f7f9;--panel:#fff;--ink:#14161a;--muted:#5d6470;--line:#e2e5ea;
  --accent:#1f5fd0;--good:#0f7b4f;--goodbg:#e6f4ec;--warn:#a8500a;--warnbg:#fdf0e3;
  --chip:#eef1f6;--shadow:0 1px 2px rgba(0,0,0,.06),0 4px 12px rgba(0,0,0,.04)}
@media (prefers-color-scheme:dark){:root{
  --bg:#101216;--panel:#181b21;--ink:#e8eaee;--muted:#98a0ad;--line:#272c35;
  --accent:#7aa7f5;--good:#5cd0a0;--goodbg:#12241c;--warn:#e0a76a;--warnbg:#2a2015;
  --chip:#222731;--shadow:0 1px 2px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:20px;margin:0 0 2px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin-bottom:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:20px}
.stat{background:var(--panel);padding:12px 14px}
.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat span{color:var(--muted);font-size:12px}
.ask{display:flex;gap:8px;margin-bottom:12px}
.ask input{flex:1;padding:11px 14px;font-size:15px;border:1px solid var(--line);
  border-radius:10px;background:var(--panel);color:var(--ink)}
.ask input:focus{outline:2px solid var(--accent);outline-offset:-1px}
.ask button{padding:11px 16px;border:0;border-radius:10px;background:var(--accent);
  color:#fff;font-weight:600;cursor:pointer}
.read{font-size:12px;color:var(--muted);min-height:18px;margin:-4px 0 14px}
.read b{color:var(--ink);font-weight:600}
.read .miss{color:var(--warn)}
.controls{padding:14px 16px;margin-bottom:18px;display:flex;flex-wrap:wrap;gap:14px 20px;align-items:flex-end}
.f{display:flex;flex-direction:column;gap:5px}
.f label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.f select,.f input[type=date],.f input[type=number]{padding:7px 9px;border:1px solid var(--line);
  border-radius:8px;background:var(--panel);color:var(--ink);font-size:13px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{padding:6px 11px;border:1px solid var(--line);border-radius:999px;background:var(--chip);
  cursor:pointer;font-size:13px;user-select:none}
.chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.reset{margin-left:auto;background:none;border:1px solid var(--line);border-radius:8px;
  padding:7px 12px;color:var(--muted);cursor:pointer;font-size:13px}
.group{margin-bottom:10px;overflow:hidden}
.ghead{display:flex;align-items:baseline;gap:12px;padding:13px 16px;cursor:pointer}
.ghead:hover{background:var(--chip)}
.gname{font-weight:600;font-size:15px}
.gmeta{color:var(--muted);font-size:12px;margin-left:auto;text-align:right}
.gbest{font-variant-numeric:tabular-nums;font-weight:600;color:var(--good);
  background:var(--goodbg);padding:2px 9px;border-radius:999px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;text-transform:uppercase;
  letter-spacing:.05em;padding:8px 16px;border-top:1px solid var(--line)}
td{padding:7px 16px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
tbody tr:hover{background:var(--chip)}
.num{text-align:right}
.leg{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--chip);color:var(--muted)}
.saver{color:var(--good);font-weight:600}
.empty{padding:40px 16px;text-align:center;color:var(--muted)}
.foot{margin-top:28px;color:var(--muted);font-size:12px;line-height:1.7}
.scroll{overflow-x:auto}
`;

/**
 * The natural-language box, running entirely in the page.
 *
 * Deliberately a parser rather than a model: it works offline, costs nothing,
 * and sends no part of your travel plans anywhere. The trade is that it
 * understands a vocabulary rather than intent, so it always reports what it did
 * NOT understand instead of quietly ignoring half the question.
 *
 * These are real functions, shipped to the page via toString(), rather than
 * source held in a template literal. A template literal eats one level of
 * backslash, which turned every "\\b" into a backspace character and every
 * "\\s" into a literal s — regexes that still compile, match the wrong thing,
 * and blank stray characters out of the query. Written this way the source in
 * this file is the source that runs, and it can be unit-tested directly.
 */

const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7,
  august:8, september:9, october:10, november:11, december:12, jan:1, feb:2, mar:3,
  apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

const WEEKDAYS = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5,
  saturday:6, sun:0, mon:1, tue:2, tues:2, wed:3, thu:4, thur:4, thurs:4, fri:5, sat:6 };

const TAGWORDS = { beach:"beach", beaches:"beach", sea:"beach", seaside:"beach",
  coast:"beach", sun:"beach", sunny:"beach", warm:"beach", city:"city", cities:"city",
  ski:"ski", skiing:"ski", snow:"ski", mountains:"ski", nature:"nature",
  hiking:"nature", fjords:"nature", outdoors:"nature" };

const FILLER = ["a","an","the","to","in","on","at","for","from","is","are","there","any",
  "what","where","when","show","me","my","i","we","us","can","could","find","get","go",
  "fly","flying","flight","flights","trip","trips","away","award","awards","points",
  "point","pts","and","or","of","with","please","available","availability","somewhere",
  "anywhere","place","places","during","cheap","cheaper","fare","fares","seat","seats",
  "hours","hour","hrs","one","two","some","this","that","next","just","only","all"];

/**
 * Names a person would actually type for an airport. "New York JFK" has to
 * answer to "new york", and "Crete (Heraklion)" to both halves, or asking for a
 * city by its ordinary name matches nothing.
 */
/**
 * Strip accents. People type "malaga", not "Málaga", and a name that only
 * matches when accented is a name that never matches.
 *
 * Decomposing and dropping the combining marks leaves the string the same
 * length for every precomposed accent, which matters because the parser blanks
 * out matched spans by offset.
 */
function fold(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function cityAliases(city) {
  const c = fold(String(city).toLowerCase());
  const out = new Set([c]);
  const paren = c.match(/^([^(]+)\s*\(([^)]+)\)$/);
  if (paren) { out.add(paren[1].trim()); out.add(paren[2].trim()); }
  const bare = c.replace(/\s*\([^)]*\)/, "").trim();
  out.add(bare);
  // Trailing airport qualifiers are not part of the city's name.
  const trimmed = bare.replace(/\s+(jfk|newark|heathrow|gatwick|narita|haneda|malpensa|linate|south|north|orly)$/, "").trim();
  if (trimmed.length >= 4) out.add(trimmed);
  return [...out].filter(Boolean);
}

/**
 * Read a question into filters.
 *
 * Matched spans are blanked out as they are consumed, which does two jobs: a
 * later pattern cannot re-read text an earlier one claimed, and whatever is
 * still standing at the end is exactly what was not understood.
 */
function parseAsk(text, DATA) {
  let q = " " + fold(String(text).toLowerCase()).replace(/[,.!?]/g, " ") + " ";
  const f = {}, used = [];
  const eat = (re, fn) => {
    const m = q.match(re);
    if (!m) return false;
    fn(m);
    used.push(m[0].trim());
    q = q.slice(0, m.index) + " ".repeat(m[0].length) + q.slice(m.index + m[0].length);
    return true;
  };
  const word = (w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");

  // Hours BEFORE points: "under 4 hours" would otherwise be read by the points
  // pattern as a 4,000-point ceiling, which silently matches nothing at all.
  eat(/\b(?:under|below|less than|within|max|maximum|up to|shorter than)\s+([\d.]+)\s*(?:hours?|hrs?|h)\b/,
    (m) => { f.maxHours = parseFloat(m[1]); });
  eat(/\b(?:over|more than|longer than|at least)\s+([\d.]+)\s*(?:hours?|hrs?|h)\b/,
    (m) => { f.minHours = parseFloat(m[1]); });

  eat(/\b(?:under|below|less than|max|maximum|up to|cheaper than)\s+([\d.,]+)\s*(k\b|thousand|points?|pts?)?/,
    (m) => {
      let n = parseFloat(m[1].replace(/[.,]/g, ""));
      if (/^k|thousand/.test(m[2] || "")) n *= 1000;
      // "under 20" means 20k; nothing SAS sells costs twenty points.
      if (n < 1000) n *= 1000;
      f.maxPoints = n;
    });

  eat(/\b(?:short|quick|nearby|close by)\b/, () => { if (f.maxHours == null) f.maxHours = 3.5; });
  eat(/\b(?:long haul|longhaul|far away)\b/, () => { if (f.minHours == null) f.minHours = 5; });

  for (const w of Object.keys(TAGWORDS).sort((a, b) => b.length - a.length)) {
    eat(word(w), () => { (f.tags = f.tags || []).push(TAGWORDS[w]); });
  }
  if (f.tags) f.tags = [...new Set(f.tags)];

  for (const name of Object.keys(MONTHS).sort((a, b) => b.length - a.length)) {
    const hit = eat(word(name), () => {
      const m = MONTHS[name], mm = String(m).padStart(2, "0");
      // Whichever year of that month the pull actually covers.
      const years = [...new Set(DATA.rows.map((r) => +r[2].slice(0, 4)))].sort();
      const y = years.find((yy) => DATA.rows.some((r) => r[2].startsWith(yy + "-" + mm))) || years[0];
      f.from = y + "-" + mm + "-01";
      f.to = y + "-" + mm + "-" + new Date(Date.UTC(y, m, 0)).getUTCDate();
    });
    if (hit) break;
  }

  const wd = [];
  eat(/\bweekends?\b/, () => { wd.push(5, 6, 0); });
  for (const name of Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length)) {
    eat(new RegExp("\\b" + name + "s?\\b"), () => { wd.push(WEEKDAYS[name]); });
  }
  if (wd.length) f.weekdays = [...new Set(wd)];

  // Places, longest name first, so "new york" wins over any shorter name it contains.
  const names = [];
  for (const code in DATA.places) {
    const [city, country] = DATA.places[code];
    for (const alias of cityAliases(city)) names.push({ t: alias, code });
    names.push({ t: fold(country.toLowerCase()), country: country.toLowerCase() });
  }
  names.sort((a, b) => b.t.length - a.t.length);
  let matchedAlias = null;
  for (const n of names) {
    if (n.t.length < 3) continue;
    const hit = eat(word(n.t), () => {
      if (n.country) f.country = n.country;
      else { f.dests = [n.code]; matchedAlias = n.t; }
    });
    if (hit) break;
  }
  // A bare IATA code, but never home: every row mentions that one.
  if (!f.dests && !f.country) {
    for (const c of Object.keys(DATA.places)) {
      if (c === DATA.home) continue;
      if (eat(word(c.toLowerCase()), () => { f.dests = [c]; })) break;
    }
  }
  // Every airport answering to the matched name counts. Comparing full city
  // strings would not do it: "New York JFK" and "New York Newark" are different
  // strings for one city, so asking for New York would return a single airport.
  if (f.dests && matchedAlias) {
    const set = new Set(f.dests);
    for (const other in DATA.places) {
      if (cityAliases(DATA.places[other][0]).includes(matchedAlias)) set.add(other);
    }
    f.dests = [...set];
  }

  eat(/\breturns?\b|\bcoming back\b|\bway back\b/, () => { f.leg = "inbound"; });
  if (!f.leg) eat(/\boutbound\b|\bgoing out\b/, () => { f.leg = "outbound"; });
  eat(/\bcheapest\b|\bbest\b|\bbargains?\b/, () => {});

  const filler = new RegExp("^(" + FILLER.join("|") + ")$");
  const missed = [...new Set(q.split(/\s+/).filter(
    (w) => w && w.length > 2 && !filler.test(w) && !/^[\d.,]+$/.test(w)))];
  return { filters: f, understood: used, missed };
}

/** Ship the real source, so what runs is what is written and tested here. */
const PARSER = [
  "const MONTHS=" + JSON.stringify(MONTHS) + ";",
  "const WEEKDAYS=" + JSON.stringify(WEEKDAYS) + ";",
  "const TAGWORDS=" + JSON.stringify(TAGWORDS) + ";",
  "const FILLER=" + JSON.stringify(FILLER) + ";",
  fold.toString(),
  cityAliases.toString(),
  parseAsk.toString(),
].join("\n");

function buildBrowseHtml(rows, meta = {}) {
  const data = encode(rows, meta);
  const generated = new Date(data.generatedAt).toISOString().replace("T", " ").slice(0, 16);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SAS award prices</title>
<style>${STYLE}</style></head>
<body><div class="wrap">
<h1>SAS EuroBonus award prices</h1>
<div class="sub">Pulled ${esc(generated)} UTC · everything below is offline, in this file.</div>

<div class="stats" id="stats"></div>

<div class="ask">
  <input id="ask" placeholder="cheapest beach under 4 hours in March&hellip;" autocomplete="off">
  <button id="askgo">Ask</button>
</div>
<div class="read" id="read"></div>

<div class="card controls">
  <div class="f"><label>Group by</label>
    <select id="by">
      <option value="country">Country</option>
      <option value="tag">Type of trip</option>
      <option value="duration">Flight time</option>
      <option value="region">Region</option>
      <option value="dest">Destination</option>
    </select></div>
  <div class="f"><label>Leg</label>
    <select id="leg"><option value="">Both</option>
      <option value="0">Outbound</option><option value="1">Return</option></select></div>
  <div class="f"><label>Max points</label><input type="number" id="maxpts" step="1000" placeholder="any"></div>
  <div class="f"><label>Max hours</label><input type="number" id="maxhrs" step="0.5" placeholder="any"></div>
  <div class="f"><label>From</label><input type="date" id="from"></div>
  <div class="f"><label>To</label><input type="date" id="to"></div>
  <div class="f"><label>Type</label><div class="chips" id="tags"></div></div>
  <button class="reset" id="reset">Reset</button>
</div>

<div id="out"></div>

<div class="foot">
  Flight times are estimated from great-circle distance and model a non-stop, so they are a
  lower bound. Prices are a snapshot from the pull above, not a live quote &mdash;
  <strong>verify on flysas.com before booking</strong>.
</div>
</div>
<script>
const DATA = ${JSON.stringify(data)};
${PARSER}

const R = DATA.rows.map(r => ({
  o:r[0], d:r[1], date:r[2], points:r[3], cash:r[4],
  cur:DATA.currencies[r[5]], inbound:r[6]===1, cabin:DATA.cabins[r[7]],
}));
// The far end of the route is what makes a leg interesting: a flight home from
// Malaga is still a Spanish beach, not a Danish one.
for (const r of R) {
  r.away = r.inbound ? r.o : r.d;
  const p = DATA.places[r.away] || ["?","Unknown","Unknown",[],null];
  r.city=p[0]; r.country=p[1]; r.region=p[2]; r.tags=p[3]||[];
  r.mins=p[4]; r.hours = p[4]===null ? null : p[4]/60;
}
const BANDS=[[2,"under 2h"],[3.5,"2–3.5h"],[5,"3.5–5h"],[9,"5–9h"],[1e9,"over 9h"]];
const band=h=>h===null?"unknown":BANDS.find(b=>h<=b[0])[1];
for (const r of R) r.band = band(r.hours);

// Saver = the cheapest this route+leg has ever been seen at.
const best={};
for(const r of R){const k=r.o+r.d+r.cabin;if(!(k in best)||r.points<best[k])best[k]=r.points}
for(const r of R) r.saver = r.points===best[r.o+r.d+r.cabin];

const $=id=>document.getElementById(id);
const fmt=n=>n.toLocaleString("en-GB");
const hrs=h=>h===null?"":Math.floor(h)+"h"+String(Math.round((h-Math.floor(h))*60)).padStart(2,"0");
const state={tags:new Set()};

const ALLTAGS=[...new Set(R.flatMap(r=>r.tags))].sort();
$("tags").innerHTML=ALLTAGS.map(t=>'<span class="chip" role="button" aria-pressed="false" data-t="'+t+'">'+t+'</span>').join("");
$("tags").onclick=e=>{const c=e.target.closest("[data-t]");if(!c)return;
  const t=c.dataset.t; state.tags.has(t)?state.tags.delete(t):state.tags.add(t);
  c.setAttribute("aria-pressed",state.tags.has(t)); render()};

function current(){
  const leg=$("leg").value, mp=+$("maxpts").value||null, mh=+$("maxhrs").value||null;
  const from=$("from").value||null, to=$("to").value||null;
  return R.filter(r=>{
    if(leg!==""&&(r.inbound?1:0)!==+leg)return false;
    if(mp&&r.points>mp)return false;
    if(mh!==null&&(r.hours===null||r.hours>mh))return false;
    if(state.minHours&&(r.hours===null||r.hours<state.minHours))return false;
    if(from&&r.date<from)return false;
    if(to&&r.date>to)return false;
    if(state.weekdays&&!state.weekdays.includes(new Date(r.date+"T00:00:00Z").getUTCDay()))return false;
    if(state.country&&r.country.toLowerCase()!==state.country)return false;
    if(state.dests&&!state.dests.includes(r.away))return false;
    for(const t of state.tags)if(!r.tags.includes(t))return false;
    return true});
}

function render(){
  const rows=current(), by=$("by").value;
  const keyOf={country:r=>r.country,region:r=>r.region,duration:r=>r.band,
    dest:r=>r.city+" ("+r.away+")"}[by];

  const g=new Map();
  const add=(k,r)=>{const e=g.get(k)||{k,rows:[],dests:new Set(),best:null};
    e.rows.push(r);e.dests.add(r.away);
    if(!e.best||r.points<e.best.points)e.best=r;g.set(k,e)};
  for(const r of rows){ if(by==="tag"){ if(!r.tags.length)add("(untagged)",r);
      for(const t of r.tags)add(t,r);} else add(keyOf(r),r); }

  let groups=[...g.values()];
  groups.sort(by==="duration"
    ? (a,b)=>BANDS.findIndex(x=>x[1]===a.k)-BANDS.findIndex(x=>x[1]===b.k)
    : (a,b)=>a.best.points-b.best.points);

  $("stats").innerHTML=[
    ["Prices",fmt(rows.length)],["Destinations",new Set(rows.map(r=>r.away)).size],
    ["Countries",new Set(rows.map(r=>r.country)).size],
    ["Cheapest",rows.length?fmt(Math.min(...rows.map(r=>r.points)))+" pts":"—"],
    ["Dates",rows.length?rows.reduce((a,r)=>r.date<a?r.date:a,"9999").slice(5)+" → "+
      rows.reduce((a,r)=>r.date>a?r.date:a,"").slice(5):"—"],
  ].map(([l,v])=>'<div class="stat"><b>'+v+'</b><span>'+l+'</span></div>').join("");

  if(!groups.length){$("out").innerHTML='<div class="card empty">Nothing matches those filters.</div>';return}

  $("out").innerHTML=groups.map((e,i)=>{
    const hs=e.rows.map(r=>r.hours).filter(h=>h!==null);
    const span=hs.length?hrs(Math.min(...hs))+(Math.min(...hs)===Math.max(...hs)?"":"+"):"";
    const top=e.rows.slice().sort((a,b)=>a.points-b.points||a.date.localeCompare(b.date)).slice(0,12);
    return '<div class="card group"><div class="ghead" data-i="'+i+'">'+
      '<span class="gname">'+e.k+'</span>'+
      '<span class="gbest">'+fmt(e.best.points)+' pts</span>'+
      '<span class="gmeta">'+e.dests.size+' destination'+(e.dests.size===1?"":"s")+
        ' · '+e.rows.length+' date'+(e.rows.length===1?"":"s")+(span?' · '+span:"")+'</span></div>'+
      '<div class="scroll" id="g'+i+'" hidden><table><thead><tr>'+
      '<th>Date</th><th>Route</th><th>Leg</th><th>Where</th><th class="num">Flight</th>'+
      '<th class="num">Points</th><th class="num">Taxes</th></tr></thead><tbody>'+
      top.map(r=>'<tr><td>'+r.date+'</td><td>'+r.o+'–'+r.d+'</td>'+
        '<td><span class="leg">'+(r.inbound?"return":"out")+'</span></td>'+
        '<td>'+r.city+'</td><td class="num">'+hrs(r.hours)+'</td>'+
        '<td class="num'+(r.saver?' saver':'')+'">'+fmt(r.points)+'</td>'+
        '<td class="num">'+(r.cash===null?"":fmt(r.cash)+" "+r.cur)+'</td></tr>').join("")+
      '</tbody></table>'+(e.rows.length>12?'<div class="empty">'+(e.rows.length-12)+' more — narrow the filters to see them.</div>':"")+
      '</div></div>'}).join("");

  $("out").onclick=ev=>{const h=ev.target.closest(".ghead");if(!h)return;
    const b=$("g"+h.dataset.i); b.hidden=!b.hidden};
}

function ask(){
  const t=$("ask").value.trim();
  if(!t){$("read").textContent="";return}
  const {filters:f,understood,missed}=parseAsk(t,DATA);
  state.country=f.country||null; state.dests=f.dests||null; state.weekdays=f.weekdays||null;
  state.minHours=f.minHours||null;
  state.tags=new Set(f.tags||[]);
  $("maxpts").value=f.maxPoints||""; $("maxhrs").value=f.maxHours||"";
  $("from").value=f.from||""; $("to").value=f.to||"";
  $("leg").value=f.leg==="inbound"?"1":f.leg==="outbound"?"0":"";
  if(f.country||f.dests)$("by").value="dest"; else if(f.tags&&f.tags.length)$("by").value="tag";
  for(const c of $("tags").children)c.setAttribute("aria-pressed",state.tags.has(c.dataset.t));
  $("read").innerHTML = (understood.length?'Read as: <b>'+understood.join("</b>, <b>")+'</b>. ':'Nothing recognised. ')+
    (missed.length?'<span class="miss">Ignored: '+missed.join(", ")+'</span>':'');
  render();
}

$("askgo").onclick=ask;
$("ask").addEventListener("keydown",e=>{if(e.key==="Enter")ask()});
for(const id of ["by","leg","maxpts","maxhrs","from","to"])$(id).addEventListener("input",render);
$("reset").onclick=()=>{state.tags=new Set();
  state.country=state.dests=state.weekdays=state.minHours=null;
  for(const id of ["maxpts","maxhrs","from","to","ask"])$(id).value="";
  $("leg").value="";$("read").textContent="";
  for(const c of $("tags").children)c.setAttribute("aria-pressed","false");render()};
render();
</script></body></html>`;
}

module.exports = { buildBrowseHtml, encode, parseAsk, cityAliases, fold };

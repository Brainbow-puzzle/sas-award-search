# SAS EuroBonus award search

Pulls SAS award prices into a **local SQLite database**, then lets you query it
offline as much as you like — "cheapest business anywhere in March", "economy
under 25k on a Friday", "what got cheaper since last week".

SAS makes you search one route at a time. This does the retrieval once, in
bulk, and turns the answers into data you own — no EuroBonus login required for
the low-price calendar.

---

## The idea: capture once, replay many, query offline

The naive approach — load a booking page per date — is slow, heavy and
rate-limit bait. This tool does something better:

1. **`capture`** — you run *one* award search by hand. The tool records every
   request the page made and works out which one actually returns prices.
2. **`pull`** — it replays that request across all your routes and dates,
   reusing your session. No page rendering, one HTTP call per request.
3. **`query`** — everything lands in SQLite, so lookups are instant, offline,
   and as arbitrary as you like.

The big win is step 2 — and it comes with one real decision, which the tool
leaves to you rather than making for you.

| | **month** per request | **day** per request |
| --- | --- | --- |
| Source | low-price calendar | a normal single-date search |
| Cost | 12 requests → 590 prices | ~368 requests for the same span |
| Carries | one headline price per date | price **per cabin**, seats, flight no. |

The calendar is roughly 30x cheaper, and for "which dates have saver space" it
is the right tool. But SAS's calendar reports a single figure per date, so if
you want *business-class* prices — or seat counts — you need the day path.

Capture either or both, then choose at pull time:

```bash
node search.js pull --granularity=month   # cheap sweep
node search.js pull --granularity=day     # cabin-level detail
```

---

## What "cheap" actually means here

**SAS award prices are mostly fixed, not dynamic.** Points come from a
zone-and-cabin chart: CPH→New York in business is the same number of points in
March as in November. So "when is it cheap" really means **"when is there saver
award space"** — a date is either at the chart price or it has none.

What the tool hunts for:

- Dates where SAS-operated flights **lack** saver space and fall back to a
  higher dynamic price (`--saver` filters these out).
- Which **destinations** sit in cheaper zones (`--cheapest`).
- Whether anything **moved** since your last pull (`--changes`).

Reference points after the December 2025 devaluation: long-haul business went
50k → 60k one-way, premium economy 40k → 45k, intra-Europe business rose ~33%,
economy unchanged. Seats release up to **330 days** ahead, which is the horizon
the scanner refuses to search past.

---

## Why this runs on your machine

SAS's low-price calendar ("Lavpriskalender", with **Betal med point** ticked)
shows award prices per date **without a login**, so the common case needs no
credentials at all. What it does need is a real browser: the booking backend
rejects plain HTTP clients, so the tool drives Chromium and reads the JSON the
page fetches.

`login` remains available for anything your account sees that an anonymous
visitor does not. If you use it, nothing about your account leaves your machine —
you type your credentials into the real SAS page and only a session file stays on
disk (gitignored, along with `config.json` and `out/`).

---

## Setup

```bash
npm install
npx playwright install chromium
cp config.example.json config.json     # set your origins, destinations, dates
```

**Node 22 or newer is required.** The database uses `node:sqlite`, which is
built into Node from 22 and does not exist before it — on Node 18 the tool
fails at startup. Check with `node --version`. Nothing else to install:
Playwright is the only dependency, and SQLite comes with Node.

## Use it

### 1. Get a recipe

The endpoint SAS's low-price calendar uses is already known, so there is nothing
to discover and no browser to drive:

```bash
node search.js recipe
```

That writes `out/recipes.json` pointing at

```
GET www.sas.dk/bff/datepicker/flights/offers/v1?...&bookingFlow=points
```

a plain GET needing no login, where one request covers a whole month for a
route. Skip straight to step 3.

<details>
<summary>If SAS has changed the endpoint, rediscover it by hand</summary>

### Capture a real search

```bash
node search.js capture
```

A browser opens — **no login required**. Open the low-price calendar
("Lavpriskalender"), tick **Betal med point** / **Pay with points**, pick your
route and page to the month you want. Press Enter, then tell it what you
searched (origin, destination, dates) so the request can be re-aimed.

For **cabin-level** prices, search one specific date instead of using the
calendar — that is the request that returns per-cabin results. Capture both if
you want the choice later; `pull --granularity=` then picks between them.

If your account sees prices an anonymous visitor does not, run
`node search.js login` first and capture again.

It prints the recipes it built, best first:

```
  [0] GET /api/calendar
      50 price(s) in capture — whole window per request
      varies: origin, destination, date
```

Raw payloads land in `out/captured/` if you ever need to look. You can also
hand a URL straight to `recipe` instead:

```bash
node search.js recipe --url="https://www.sas.dk/...&origin=CPH&departureDate=2026-09-01"
```

It reads the route and dates out of the query string by shape, so `--origin`,
`--destination` and `--date` are only needed when that is ambiguous.

</details>

### 2. Check that prices can actually be read

```bash
node search.js diagnose
```

This is the step that decides whether the rest of the tool is worth anything.
It re-reads the payloads in `out/captured/` **offline** and reports, per
response, how many prices were extractable and how well annotated they were:

```
  GET api.flysas.com/offers/calendar
      312 price(s)  — CALENDAR-STYLE, covers a whole window per request
      annotated: date 312/312  cabin 312/312  dest 312/312  taxes 300/312  seats 0/312
      dates: 31 distinct, 2026-10-01 .. 2026-10-31
```

When nothing is found it does the useful thing instead of shrugging — it names
the numbers the harvester *rejected* and where they live:

```
  POST api.flysas.com/graphql
      no prices
      1 number(s) in award range that the harvester ignored:
        data.awardSearch.results[].bookingClasses[].redeemCost.qty
          35,000, 105,000  (x16)
      -> if any of those are award points, widen isPointsKey() in lib/harvest.js
```

Because it reads from disk, you can edit `lib/harvest.js` and re-run it as often
as you like — **no second capture, no browser, no network**. It exits non-zero
when no prices are extractable, so it also works as a smoke test after a SAS
redesign.

### 3. Pull

```bash
node search.js pull                        # cheapest recipe captured
node search.js pull --granularity=day      # one request per date, with cabins
node search.js pull --granularity=month    # one request per month, no cabins
node search.js pull --recipe=1             # pick an exact recipe by index
node search.js pull --limit=5              # small test run first
```

`--limit` first, always: it confirms the data looks right before committing to
a few hundred requests. Asking for a granularity you never captured fails with
the capture to re-run, rather than silently using the other one.

### 4. Query — this is the part you wanted

```bash
node search.js query --stats
node search.js query --cheapest
node search.js query --cheapest --cabin=business
node search.js query --max-points=30000 --from=2026-10-01 --to=2026-11-30
node search.js query --cabin=economy --weekdays=5,0 --max-points=25000
node search.js query --destination=BKK --saver --order=date
node search.js query --changes
node search.js query --cabin=business --csv=biz.csv
```

| Filter | Meaning |
| --- | --- |
| `--cheapest` | cheapest price per destination |
| `--changes` | prices that moved between pulls |
| `--stats` | what the database holds |
| `--origin` `--destination` `--cabin` | narrow to a route or cabin |
| `--max-points` `--min-points` | points range |
| `--max-cash` `--min-seats` | taxes ceiling, seats floor |
| `--from` `--to` | departure date range |
| `--weekdays=5,0` | Fridays and Sundays (0 = Sunday) |
| `--saver` | only dates at the cheapest price for that route+cabin |
| `--order=points\|date\|cash\|seats` | sort |
| `--csv[=path]` | also write CSV |

The database is plain SQLite at `out/awards.db` — point any tool at it:

```bash
sqlite3 out/awards.db "SELECT destination, MIN(points) FROM offers
                       WHERE cabin='business' GROUP BY destination ORDER BY 2"
```

### 5. Visual report

```bash
node search.js report
```

Writes `out/report.html`: a colour-coded calendar per route and cabin. Green =
saver, red = above saver, grey = no space found.

---

## What's in the database

| Table | Holds |
| --- | --- |
| `offers` | current best-known price per route/date/cabin/flight |
| `observations` | append-only log of every price ever seen, so `--changes` can tell you what moved |
| `searches` | which windows were actually queried, so a gap means "no space" rather than "never looked" |

Re-pulling is idempotent — it refreshes prices rather than duplicating rows.

---

## How prices are extracted

Prices come from the JSON the site fetches, not the rendered HTML, because
payloads survive redesigns that break CSS selectors.

`lib/harvest.js` assumes **no schema**. It walks any JSON, pulls out every
points-like number, and annotates it with the route, date, cabin, taxes and
seat count it finds nearby — including from sibling branches and from
**date-keyed maps**, since real payloads scatter these. A backend field rename
degrades the annotations instead of breaking the run.

Date-keyed maps matter because that is what SAS actually returns:

```json
{ "outbound": { "2026-09-08": { "points": 10000, "totalPrice": 284 } } }
```

The date is the *key*, not a value. Reading dates only from values yielded one
undated row from a month of prices — and `pull` discards undated rows.

If SAS changes enough that nothing is found, `out/captured/` has the raw
payloads; the matchers are at the top of `lib/harvest.js`.

---

## Tests

```bash
npm test                    # harvester, planning and diagnostics; no browser
node test-e2e.js            # UI-driven path against the local mock site
node test-replay-e2e.js     # capture -> recipe -> replay -> SQLite -> query
```

If the preinstalled Chromium does not match your Playwright build, point the
e2e suites at it: `CHROMIUM_PATH=/path/to/chrome node test-e2e.js`.

`mock/server.js` serves fake award data over XHR, including a calendar
endpoint, so the whole chain is verifiable offline. It says nothing about
whether any of this matches SAS's real site — only `capture` can tell you that.

---

## Troubleshooting

**HTTP 403 on every request.** Cloudflare fronts www.sas.dk and refuses clients
that have not loaded a page: no `__cf_bm` cookie, no `Referer`, no `sec-fetch-*`.
`pull` opens the site once before replaying, and `recipe` writes those headers
in, so this should not happen — if it does, run `capture` to record what your
browser actually sends. No login will fix a 403; it is refusing the client, not
the account.

**Pulls return no JSON / HTTP 302.** If you captured while logged in, the session
expired: `node search.js login`, then `capture` again. If you captured logged
out, the recipe's headers or query shape have gone stale — re-run `capture`.

**Pull wants far more requests than expected.** You are on a day-granularity
recipe. That is correct if you want cabin-level prices; if you only need "which
dates have space", capture the low-price calendar and use
`pull --granularity=month`.

**"No day-granularity recipe was captured".** Your capture only recorded the
calendar. Re-run `capture` and search ONE specific date — that is the request
that returns per-cabin prices.

**"prices without dates" warning during a month pull.** The payload had prices
whose dates the harvester couldn't locate, so they're dropped rather than
guessed — guessing would stack a whole month onto one day. `node search.js
diagnose` reports the date-annotation gap and suggests the field to read.

**Nothing found at all after capture.** Run `node search.js diagnose`. It names
the fields holding numbers the harvester rejected, so you can widen a matcher in
`lib/harvest.js` and re-run `diagnose` against the payloads already on disk —
no second capture needed.

**It got slow or started failing.** You're likely rate-limited. Raise
`throttle` in config, pull a narrower range, space runs out.

---

## Limits

- Only what your account can see. Partner (SkyTeam) award space may use a
  different flow — capture that separately if you want it.
- **Verify on flysas.com before booking.** Never book off this report alone.
- Availability moves constantly; a pull is a snapshot. That's what
  `--changes` and the `observations` table are for.
- This automates searches you're entitled to make as a logged-in member. It is
  not a booking bot and deliberately does not automate booking. Requests run
  one at a time with jittered delays — please leave the throttle alone.

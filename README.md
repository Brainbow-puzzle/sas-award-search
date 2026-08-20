# SAS EuroBonus award search

Pulls SAS award prices into a **local SQLite database**, then lets you query it
offline as much as you like — "cheapest business anywhere in March", "economy
under 25k on a Friday", "what got cheaper since last week".

flysas.com makes you search one route and one date at a time. This does the
retrieval once, in bulk, and turns the answers into data you own.

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

The big win is step 2. If the search you captured was a **flexible-date or
calendar view**, one request returns a whole month, and the tool detects this
automatically and iterates by month instead of by day:

```
12 requests  ->  590 prices   (4 destinations x 3 months)
```

The same coverage date-by-date would be 368 page loads. **So when you run
`capture`, use the site's flexible-date view if it has one** — that single
choice is what makes this cheap.

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

SAS's award search is behind a EuroBonus login and its booking backend rejects
plain HTTP clients. The tool drives a real Chromium session, so requests carry
your logged-in cookies. Nothing about your account leaves your machine: you type
your credentials into the real SAS page, and only a session file stays on disk
(gitignored, along with `config.json` and `out/`).

It also can't run in CI or on a server — it needs your login.

---

## Setup

```bash
cd tools/sas-award-search
npm install
npx playwright install chromium
cp config.example.json config.json     # set your origins, destinations, dates
```

Node 18+ is required; SQLite is built into Node 22+ and needs no install.

## Use it

### 1. Log in (once)

```bash
node search.js login
```

A browser opens. Log in, handle 2FA, press Enter. Re-run whenever pulls start
coming back empty — sessions expire.

### 2. Capture a real search (once)

```bash
node search.js capture
```

A browser opens. Run one award search by hand paying with points — **use the
flexible-date/calendar view if there is one**. Press Enter, then tell it what
you searched (origin, destination, dates) so the request can be re-aimed.

It prints the recipes it built, best first:

```
  [0] GET /api/calendar
      50 price(s) in capture — whole window per request
      varies: origin, destination, date
```

Raw payloads land in `out/captured/` if you ever need to look.

### 3. Pull

```bash
node search.js pull                # uses recipe [0]
node search.js pull --recipe=1     # try another
node search.js pull --limit=5      # small test run first
```

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
seat count it finds nearby — including from sibling branches, since real
payloads scatter these. A backend field rename degrades the annotations instead
of breaking the run.

If SAS changes enough that nothing is found, `out/captured/` has the raw
payloads; the matchers are at the top of `lib/harvest.js`.

---

## Tests

```bash
npm test                    # harvester + planning logic, no browser
node test-e2e.js            # UI-driven path against the local mock site
node test-replay-e2e.js     # capture -> recipe -> replay -> SQLite -> query
```

`mock/server.js` serves fake award data over XHR, including a calendar
endpoint, so the whole chain is verifiable offline. It says nothing about
whether any of this matches SAS's real site — only `capture` can tell you that.

---

## Troubleshooting

**Pulls return no JSON / HTTP 302.** Session expired: `node search.js login`.

**"no calendar-style request was captured".** Your capture recorded a
single-date search. Re-run `capture` using the site's flexible-date view to cut
the request count dramatically.

**"prices without dates" warning during a month pull.** The payload had prices
whose dates the harvester couldn't locate, so they're dropped rather than
guessed — guessing would stack a whole month onto one day. Check
`out/captured/` and extend the date matcher.

**Nothing found at all after capture.** No response carried recognisable points
data. The raw payloads in `out/captured/` are what you need to extend
`lib/harvest.js`.

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

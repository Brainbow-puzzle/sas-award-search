# SAS EuroBonus award search

Scans SAS award availability across many destinations and dates at once, and
reports where your EuroBonus points go furthest — the thing flysas.com makes you
do one search at a time.

Output is a console table plus a self-contained HTML report with a colour-coded
calendar per route and cabin.

---

## The thing worth knowing before you start

**SAS award prices are mostly fixed, not dynamic.** Points come from a
zone-and-cabin chart: CPH→New York in business is the same number of points in
March as in November. So "when is it cheap" is really **"when is there saver
award space"** — a date is either at the chart price or it has none.

Two exceptions are what this tool actually hunts for:

- SAS-operated flights **without** saver space fall back to a higher dynamic
  price. Those show as "above saver" in the report.
- Which **destinations** sit in cheaper zones, and which dates have space at all.

So read the calendar as an availability map, not a price curve. Green means the
chart price is available; grey means nothing was returned; red means you would be
overpaying versus the same route on a better date.

Reference points after the December 2025 devaluation: long-haul business went
50k → 60k one-way, premium economy 40k → 45k, intra-Europe business rose ~33%,
and economy was unchanged. Seats are released up to **330 days** ahead, which is
the horizon the scanner refuses to search past.

---

## Why this runs on your machine

SAS's award search sits behind a EuroBonus login, and the booking backend
rejects plain HTTP clients. The tool therefore drives a real Chromium window
using **your** logged-in session. Nothing about your account leaves your
machine: you type your credentials into the real SAS page, and only a session
cookie file stays on disk (gitignored).

It also means this cannot run in CI or on a server — it needs your login.

---

## Setup

```bash
cd tools/sas-award-search
npm install
npx playwright install chromium
cp config.example.json config.json
```

## Use it

### 1. Log in (once)

```bash
node search.js login
```

A browser opens. Log in to EuroBonus, handle any 2FA, then press Enter in the
terminal. The session is saved to `.session.json`. Re-run this whenever scans
start coming back empty — sessions expire.

### 2. Teach it your booking URL (once)

```bash
node search.js capture
```

A browser opens. **Run one award search by hand** (pay with points, e.g.
CPH→JFK), wait for results, then press Enter. The tool records the search URL
and every JSON response the page fetched, then prints a suggested
`urlTemplate`.

Paste that template into `config.json`. This step exists because SAS's booking
URL format is not documented and changes — capturing a real one is more reliable
than guessing.

The raw responses land in `out/captured/` for reference.

### 3. Scan

```bash
node search.js scan
node search.js scan --limit=20     # try a small batch first
node search.js scan --headed       # watch it work
```

Results go to `out/offers.json` and `out/report.html`.

### 4. Re-report without re-scanning

```bash
node search.js report
```

---

## Configuration

`config.json`:

| Key | Meaning |
| --- | --- |
| `urlTemplate` | Booking URL with `{origin}`, `{destination}`, `{date}`, `{returnDate}`, `{adults}`. Dates take a format suffix: `{date:YYYYMMDD}`. |
| `origins` / `destinations` | IATA codes. The scan is every origin × destination × date. |
| `dates.from` / `dates.to` | Inclusive range, `YYYY-MM-DD`. |
| `dates.weekdays` | `null` for every day, or e.g. `[5,0]` for Fri + Sun only (0 = Sunday). |
| `dates.everyNDays` | Sample every Nth day to cover a long range cheaply. |
| `tripLengthDays` | `null` for one-way, or a number to also request a return that many days later. |
| `throttle` | Delay between searches, in ms. Defaults to 4–9s. |
| `premiumThreshold` | Ratio above the saver price before a date is flagged red. Default `1.25`. |

**Mind the size of the matrix.** 12 destinations × 60 days = 720 searches, and
at ~6s each that is over an hour. Start with `dates.everyNDays: 3` or a
`weekdays` filter, find the promising routes, then scan those closely.

Requests run strictly one at a time with randomised delays. Please leave the
throttle alone — this is a personal search tool, and hammering the site is both
rude and the fastest way to get your session blocked.

---

## How prices are extracted

The scanner reads the JSON the booking page fetches, not the rendered HTML,
because payloads survive redesigns that break CSS selectors.

It does not assume a schema. `lib/harvest.js` walks any JSON and pulls out every
points-like number along with the route, date, cabin, taxes and seat count it
can find nearby. That way a backend field rename degrades the annotations
instead of breaking the run.

If SAS changes things enough that nothing is found, `out/captured/` from a
`capture` run has the raw payloads — that is what you need to adjust the
matchers at the top of `lib/harvest.js`.

---

## Tests

```bash
npm test            # harvester + planning logic, no browser needed
node test-e2e.js    # full pipeline against the local mock site in mock/
```

The mock site in `mock/server.js` serves fake award data over XHR, so the whole
chain — browser, network capture, extraction, report — is verifiable offline.
It says nothing about whether the selectors match SAS's real site; only
`capture` can tell you that.

---

## Troubleshooting

**Every search returns 0 offers.**
Most likely the session expired (`node search.js login`) or `urlTemplate` is
wrong (`node search.js capture`). Run with `--headed` and watch what the page
actually shows — if it renders a cash fare, the template is missing whatever
parameter puts the site into points mode.

**Some dates are blank.** Usually genuine: no award space. Confirm one by hand
on flysas.com.

**Cabin shows as `?`.** The payload labelled the fare in a way
`normalizeCabin` in `lib/plan.js` doesn't recognise. Add the brand name there.

**It got slow or started failing partway.** You are probably being rate-limited.
Raise `throttle`, scan a smaller range, and space runs out.

---

## Limits

- Only what your account can see. Partner (SkyTeam) award space may be searched
  through a different flow than SAS-operated flights, so capture that flow
  separately if you want it.
- Points and taxes are read from a live page but **verify on flysas.com before
  booking**. Never book off this report alone.
- Availability moves constantly. A scan is a snapshot, not a promise.
- This automates searches you are entitled to make as a logged-in member. It is
  not a booking bot and deliberately does not automate booking. Keep the
  throttle conservative and your usage personal.

If you would rather not run anything, **AwardFares** and **seats.aero** both
track EuroBonus award space commercially, with alerts — worth a look before you
invest time here.

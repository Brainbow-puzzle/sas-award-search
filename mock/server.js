"use strict";
/**
 * Local stand-in for an award-search site, used to exercise the full pipeline
 * offline: the page fetches prices over XHR exactly like a real booking site,
 * so the scanner has to capture them from the network rather than the DOM.
 * Run: node mock/server.js  (test harness starts it automatically)
 */
const http = require("http");
const url = require("url");

// Deterministic pseudo-availability so the test is repeatable.
function priceFor(origin, destination, date) {
  const seed = [...`${origin}${destination}${date}`].reduce((a, c) => a + c.charCodeAt(0), 0);
  const longHaul = ["JFK", "BKK", "SFO"].includes(destination);
  const base = longHaul ? 60000 : 9000;
  if (seed % 5 === 0) return null;              // no award space
  if (seed % 3 === 0) return Math.round(base * 1.6); // dynamic, above saver
  return base;                                   // saver
}

const server = http.createServer((req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname === "/book") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><body><div id="results">loading</div>
<script>
  const p = new URLSearchParams(location.search);
  fetch("/api/offers?" + p.toString())
    .then(r => r.json())
    .then(d => { document.getElementById("results").textContent =
      "offers: " + (d.data.itineraries[0] ? d.data.itineraries[0].products.length : 0); });
</script></body></html>`);
    return;
  }

  if (pathname === "/api/offers") {
    const { from, to, out } = query;
    const iso = `${out.slice(0, 4)}-${out.slice(4, 6)}-${out.slice(6, 8)}`;
    const eco = priceFor(from, to, iso);
    const biz = eco === null ? null : eco * 3;
    const products = [];
    if (eco !== null) {
      products.push({ brand: { name: "SAS Go Smart" },
        award: { price: { pointsAmount: eco }, tax: { amount: 34.5, currencyCode: "EUR" } },
        seatsAvailable: 4 });
      products.push({ brand: { name: "SAS Business" },
        award: { price: { pointsAmount: biz }, tax: { amount: 88.0, currencyCode: "EUR" } },
        seatsAvailable: 2 });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { itineraries: products.length ? [{
      from: { iata: from }, to: { iata: to },
      legs: [{ flightNumber: "SK123", departure: { dateTime: `${iso}T09:15:00` } }],
      products,
    }] : [] } }));
    return;
  }

  res.writeHead(404); res.end("nope");
});

const port = Number(process.env.MOCK_PORT) || 8123;
server.listen(port, () => console.log(`mock award site on http://127.0.0.1:${port}/book`));

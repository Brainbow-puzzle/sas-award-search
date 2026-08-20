"use strict";

/**
 * What an airport code means: city, country, region, roughly how long the
 * flight is, and what people go there for.
 *
 * The database stores IATA codes and nothing else, because that is all SAS's
 * payloads carry. "Cheapest beach under four hours" needs facts about places
 * that no award endpoint will ever return, so they live here.
 *
 * Flight time is DERIVED, not typed in. Storing a guessed duration per airport
 * invites 150 small errors that nobody will ever audit; storing coordinates and
 * computing great-circle distance gives one formula to check and one place to
 * be wrong. It models a non-stop, so it is a lower bound: a routing with a
 * connection takes longer, and the tool has no way to know which you would fly.
 */

/** Effective block speed, and the fixed cost of taxi, climb and descent. */
const CRUISE_KMH = 800;
const GROUND_HOURS = 0.5;
const EARTH_RADIUS_KM = 6371;

/**
 * tags describe why someone would pick the place:
 *   beach   — the sea is the reason to go
 *   city    — a city break
 *   ski     — winter sports within reach
 *   nature  — fjords, northern lights, hiking
 * A place can be several. AGP is beach; BCN is both.
 */
const AIRPORTS = {
  // ---- Denmark, and the reference point for every duration below ----
  CPH: { city: "Copenhagen", country: "Denmark", cc: "DK", lat: 55.618, lon: 12.656, tags: ["city"] },
  BLL: { city: "Billund", country: "Denmark", cc: "DK", lat: 55.740, lon: 9.152, tags: [] },
  AAL: { city: "Aalborg", country: "Denmark", cc: "DK", lat: 57.093, lon: 9.849, tags: [] },
  AAR: { city: "Aarhus", country: "Denmark", cc: "DK", lat: 56.300, lon: 10.619, tags: ["city"] },

  // ---- Nordics ----
  ARN: { city: "Stockholm", country: "Sweden", cc: "SE", lat: 59.652, lon: 17.919, tags: ["city"] },
  GOT: { city: "Gothenburg", country: "Sweden", cc: "SE", lat: 57.663, lon: 12.280, tags: ["city"] },
  MMX: { city: "Malmö", country: "Sweden", cc: "SE", lat: 55.530, lon: 13.372, tags: [] },
  LLA: { city: "Luleå", country: "Sweden", cc: "SE", lat: 65.544, lon: 22.122, tags: ["nature", "ski"] },
  UME: { city: "Umeå", country: "Sweden", cc: "SE", lat: 63.792, lon: 20.283, tags: ["nature"] },
  VBY: { city: "Visby", country: "Sweden", cc: "SE", lat: 57.663, lon: 18.346, tags: ["beach"] },
  OSL: { city: "Oslo", country: "Norway", cc: "NO", lat: 60.194, lon: 11.100, tags: ["city", "ski"] },
  BGO: { city: "Bergen", country: "Norway", cc: "NO", lat: 60.293, lon: 5.218, tags: ["nature"] },
  SVG: { city: "Stavanger", country: "Norway", cc: "NO", lat: 58.877, lon: 5.638, tags: ["nature"] },
  TRD: { city: "Trondheim", country: "Norway", cc: "NO", lat: 63.458, lon: 10.924, tags: ["nature"] },
  TOS: { city: "Tromsø", country: "Norway", cc: "NO", lat: 69.683, lon: 18.919, tags: ["nature", "ski"] },
  BOO: { city: "Bodø", country: "Norway", cc: "NO", lat: 67.269, lon: 14.365, tags: ["nature"] },
  EVE: { city: "Harstad/Narvik", country: "Norway", cc: "NO", lat: 68.491, lon: 16.678, tags: ["nature", "ski"] },
  HEL: { city: "Helsinki", country: "Finland", cc: "FI", lat: 60.317, lon: 24.963, tags: ["city"] },
  RVN: { city: "Rovaniemi", country: "Finland", cc: "FI", lat: 66.565, lon: 25.830, tags: ["nature", "ski"] },
  OUL: { city: "Oulu", country: "Finland", cc: "FI", lat: 64.930, lon: 25.354, tags: ["nature"] },
  KEF: { city: "Reykjavík", country: "Iceland", cc: "IS", lat: 63.985, lon: -22.606, tags: ["nature"] },

  // ---- Baltics ----
  TLL: { city: "Tallinn", country: "Estonia", cc: "EE", lat: 59.413, lon: 24.833, tags: ["city"] },
  RIX: { city: "Riga", country: "Latvia", cc: "LV", lat: 56.924, lon: 23.971, tags: ["city"] },
  VNO: { city: "Vilnius", country: "Lithuania", cc: "LT", lat: 54.634, lon: 25.286, tags: ["city"] },

  // ---- British Isles ----
  LHR: { city: "London Heathrow", country: "United Kingdom", cc: "GB", lat: 51.470, lon: -0.454, tags: ["city"] },
  LGW: { city: "London Gatwick", country: "United Kingdom", cc: "GB", lat: 51.148, lon: -0.190, tags: ["city"] },
  MAN: { city: "Manchester", country: "United Kingdom", cc: "GB", lat: 53.365, lon: -2.273, tags: ["city"] },
  EDI: { city: "Edinburgh", country: "United Kingdom", cc: "GB", lat: 55.950, lon: -3.372, tags: ["city"] },
  DUB: { city: "Dublin", country: "Ireland", cc: "IE", lat: 53.421, lon: -6.270, tags: ["city"] },

  // ---- Western Europe ----
  AMS: { city: "Amsterdam", country: "Netherlands", cc: "NL", lat: 52.309, lon: 4.764, tags: ["city"] },
  BRU: { city: "Brussels", country: "Belgium", cc: "BE", lat: 50.901, lon: 4.484, tags: ["city"] },
  CDG: { city: "Paris CDG", country: "France", cc: "FR", lat: 49.010, lon: 2.548, tags: ["city"] },
  ORY: { city: "Paris Orly", country: "France", cc: "FR", lat: 48.726, lon: 2.365, tags: ["city"] },
  LYS: { city: "Lyon", country: "France", cc: "FR", lat: 45.726, lon: 5.081, tags: ["city", "ski"] },
  NCE: { city: "Nice", country: "France", cc: "FR", lat: 43.665, lon: 7.215, tags: ["beach", "city"] },
  MRS: { city: "Marseille", country: "France", cc: "FR", lat: 43.436, lon: 5.215, tags: ["beach", "city"] },
  TLS: { city: "Toulouse", country: "France", cc: "FR", lat: 43.629, lon: 1.364, tags: ["city"] },
  GVA: { city: "Geneva", country: "Switzerland", cc: "CH", lat: 46.238, lon: 6.109, tags: ["ski", "city"] },
  ZRH: { city: "Zurich", country: "Switzerland", cc: "CH", lat: 47.459, lon: 8.548, tags: ["city", "ski"] },
  FRA: { city: "Frankfurt", country: "Germany", cc: "DE", lat: 50.033, lon: 8.571, tags: ["city"] },
  MUC: { city: "Munich", country: "Germany", cc: "DE", lat: 48.354, lon: 11.786, tags: ["city", "ski"] },
  BER: { city: "Berlin", country: "Germany", cc: "DE", lat: 52.366, lon: 13.503, tags: ["city"] },
  HAM: { city: "Hamburg", country: "Germany", cc: "DE", lat: 53.630, lon: 9.988, tags: ["city"] },
  DUS: { city: "Düsseldorf", country: "Germany", cc: "DE", lat: 51.289, lon: 6.767, tags: ["city"] },
  VIE: { city: "Vienna", country: "Austria", cc: "AT", lat: 48.110, lon: 16.570, tags: ["city", "ski"] },
  SZG: { city: "Salzburg", country: "Austria", cc: "AT", lat: 47.793, lon: 13.004, tags: ["ski"] },
  INN: { city: "Innsbruck", country: "Austria", cc: "AT", lat: 47.260, lon: 11.344, tags: ["ski"] },

  // ---- Central & Eastern Europe ----
  PRG: { city: "Prague", country: "Czechia", cc: "CZ", lat: 50.101, lon: 14.260, tags: ["city"] },
  WAW: { city: "Warsaw", country: "Poland", cc: "PL", lat: 52.166, lon: 20.967, tags: ["city"] },
  KRK: { city: "Kraków", country: "Poland", cc: "PL", lat: 50.078, lon: 19.785, tags: ["city"] },
  GDN: { city: "Gdańsk", country: "Poland", cc: "PL", lat: 54.378, lon: 18.466, tags: ["city", "beach"] },
  BUD: { city: "Budapest", country: "Hungary", cc: "HU", lat: 47.437, lon: 19.256, tags: ["city"] },
  OTP: { city: "Bucharest", country: "Romania", cc: "RO", lat: 44.571, lon: 26.085, tags: ["city"] },
  SOF: { city: "Sofia", country: "Bulgaria", cc: "BG", lat: 42.696, lon: 23.411, tags: ["city", "ski"] },
  BOJ: { city: "Burgas", country: "Bulgaria", cc: "BG", lat: 42.570, lon: 27.515, tags: ["beach"] },
  VAR: { city: "Varna", country: "Bulgaria", cc: "BG", lat: 43.232, lon: 27.825, tags: ["beach"] },
  ZAG: { city: "Zagreb", country: "Croatia", cc: "HR", lat: 45.743, lon: 16.069, tags: ["city"] },
  SPU: { city: "Split", country: "Croatia", cc: "HR", lat: 43.539, lon: 16.298, tags: ["beach"] },
  DBV: { city: "Dubrovnik", country: "Croatia", cc: "HR", lat: 42.561, lon: 18.268, tags: ["beach", "city"] },
  TIV: { city: "Tivat", country: "Montenegro", cc: "ME", lat: 42.404, lon: 18.723, tags: ["beach"] },

  // ---- Iberia ----
  BCN: { city: "Barcelona", country: "Spain", cc: "ES", lat: 41.297, lon: 2.078, tags: ["city", "beach"] },
  MAD: { city: "Madrid", country: "Spain", cc: "ES", lat: 40.472, lon: -3.561, tags: ["city"] },
  AGP: { city: "Málaga", country: "Spain", cc: "ES", lat: 36.675, lon: -4.499, tags: ["beach"] },
  ALC: { city: "Alicante", country: "Spain", cc: "ES", lat: 38.282, lon: -0.558, tags: ["beach"] },
  PMI: { city: "Palma de Mallorca", country: "Spain", cc: "ES", lat: 39.552, lon: 2.739, tags: ["beach"] },
  IBZ: { city: "Ibiza", country: "Spain", cc: "ES", lat: 38.873, lon: 1.373, tags: ["beach"] },
  VLC: { city: "Valencia", country: "Spain", cc: "ES", lat: 39.489, lon: -0.481, tags: ["beach", "city"] },
  SVQ: { city: "Seville", country: "Spain", cc: "ES", lat: 37.418, lon: -5.899, tags: ["city"] },
  LPA: { city: "Gran Canaria", country: "Spain", cc: "ES", lat: 27.932, lon: -15.386, tags: ["beach"] },
  TFS: { city: "Tenerife South", country: "Spain", cc: "ES", lat: 28.044, lon: -16.572, tags: ["beach"] },
  ACE: { city: "Lanzarote", country: "Spain", cc: "ES", lat: 28.945, lon: -13.605, tags: ["beach"] },
  FUE: { city: "Fuerteventura", country: "Spain", cc: "ES", lat: 28.452, lon: -13.864, tags: ["beach"] },
  LIS: { city: "Lisbon", country: "Portugal", cc: "PT", lat: 38.774, lon: -9.134, tags: ["city", "beach"] },
  OPO: { city: "Porto", country: "Portugal", cc: "PT", lat: 41.248, lon: -8.681, tags: ["city"] },
  FAO: { city: "Faro", country: "Portugal", cc: "PT", lat: 37.014, lon: -7.966, tags: ["beach"] },
  FNC: { city: "Madeira", country: "Portugal", cc: "PT", lat: 32.694, lon: -16.778, tags: ["beach", "nature"] },

  // ---- Italy ----
  FCO: { city: "Rome", country: "Italy", cc: "IT", lat: 41.800, lon: 12.239, tags: ["city"] },
  MXP: { city: "Milan Malpensa", country: "Italy", cc: "IT", lat: 45.630, lon: 8.723, tags: ["city", "ski"] },
  LIN: { city: "Milan Linate", country: "Italy", cc: "IT", lat: 45.445, lon: 9.277, tags: ["city"] },
  VCE: { city: "Venice", country: "Italy", cc: "IT", lat: 45.505, lon: 12.352, tags: ["city"] },
  NAP: { city: "Naples", country: "Italy", cc: "IT", lat: 40.886, lon: 14.291, tags: ["city", "beach"] },
  BLQ: { city: "Bologna", country: "Italy", cc: "IT", lat: 44.535, lon: 11.289, tags: ["city"] },
  FLR: { city: "Florence", country: "Italy", cc: "IT", lat: 43.810, lon: 11.205, tags: ["city"] },
  PSA: { city: "Pisa", country: "Italy", cc: "IT", lat: 43.684, lon: 10.393, tags: ["city", "beach"] },
  CTA: { city: "Catania", country: "Italy", cc: "IT", lat: 37.467, lon: 15.064, tags: ["beach"] },
  PMO: { city: "Palermo", country: "Italy", cc: "IT", lat: 38.176, lon: 13.091, tags: ["beach"] },
  CAG: { city: "Cagliari", country: "Italy", cc: "IT", lat: 39.251, lon: 9.054, tags: ["beach"] },
  OLB: { city: "Olbia", country: "Italy", cc: "IT", lat: 40.899, lon: 9.518, tags: ["beach"] },
  BRI: { city: "Bari", country: "Italy", cc: "IT", lat: 41.139, lon: 16.761, tags: ["beach"] },

  // ---- Greece, Cyprus, Malta, Turkey ----
  ATH: { city: "Athens", country: "Greece", cc: "GR", lat: 37.937, lon: 23.945, tags: ["city", "beach"] },
  SKG: { city: "Thessaloniki", country: "Greece", cc: "GR", lat: 40.520, lon: 22.971, tags: ["city", "beach"] },
  HER: { city: "Crete (Heraklion)", country: "Greece", cc: "GR", lat: 35.340, lon: 25.180, tags: ["beach"] },
  CHQ: { city: "Crete (Chania)", country: "Greece", cc: "GR", lat: 35.532, lon: 24.150, tags: ["beach"] },
  RHO: { city: "Rhodes", country: "Greece", cc: "GR", lat: 36.405, lon: 28.086, tags: ["beach"] },
  KGS: { city: "Kos", country: "Greece", cc: "GR", lat: 36.793, lon: 27.092, tags: ["beach"] },
  JTR: { city: "Santorini", country: "Greece", cc: "GR", lat: 36.399, lon: 25.479, tags: ["beach"] },
  CFU: { city: "Corfu", country: "Greece", cc: "GR", lat: 39.602, lon: 19.912, tags: ["beach"] },
  ZTH: { city: "Zakynthos", country: "Greece", cc: "GR", lat: 37.751, lon: 20.884, tags: ["beach"] },
  LCA: { city: "Larnaca", country: "Cyprus", cc: "CY", lat: 34.875, lon: 33.625, tags: ["beach"] },
  PFO: { city: "Paphos", country: "Cyprus", cc: "CY", lat: 34.718, lon: 32.486, tags: ["beach"] },
  MLA: { city: "Malta", country: "Malta", cc: "MT", lat: 35.857, lon: 14.478, tags: ["beach", "city"] },
  IST: { city: "Istanbul", country: "Turkey", cc: "TR", lat: 41.262, lon: 28.742, tags: ["city"] },
  AYT: { city: "Antalya", country: "Turkey", cc: "TR", lat: 36.899, lon: 30.801, tags: ["beach"] },

  // ---- North America ----
  JFK: { city: "New York JFK", country: "United States", cc: "US", lat: 40.640, lon: -73.779, tags: ["city"] },
  EWR: { city: "New York Newark", country: "United States", cc: "US", lat: 40.690, lon: -74.177, tags: ["city"] },
  BOS: { city: "Boston", country: "United States", cc: "US", lat: 42.363, lon: -71.006, tags: ["city"] },
  ORD: { city: "Chicago", country: "United States", cc: "US", lat: 41.979, lon: -87.905, tags: ["city"] },
  IAD: { city: "Washington DC", country: "United States", cc: "US", lat: 38.953, lon: -77.456, tags: ["city"] },
  SFO: { city: "San Francisco", country: "United States", cc: "US", lat: 37.619, lon: -122.375, tags: ["city"] },
  LAX: { city: "Los Angeles", country: "United States", cc: "US", lat: 33.942, lon: -118.408, tags: ["city", "beach"] },
  MIA: { city: "Miami", country: "United States", cc: "US", lat: 25.796, lon: -80.287, tags: ["beach", "city"] },
  SEA: { city: "Seattle", country: "United States", cc: "US", lat: 47.450, lon: -122.309, tags: ["city", "nature"] },
  YYZ: { city: "Toronto", country: "Canada", cc: "CA", lat: 43.677, lon: -79.630, tags: ["city"] },
  YVR: { city: "Vancouver", country: "Canada", cc: "CA", lat: 49.194, lon: -123.184, tags: ["city", "nature"] },
  CUN: { city: "Cancún", country: "Mexico", cc: "MX", lat: 21.037, lon: -86.877, tags: ["beach"] },

  // ---- Asia & Middle East ----
  BKK: { city: "Bangkok", country: "Thailand", cc: "TH", lat: 13.690, lon: 100.750, tags: ["city"] },
  HKT: { city: "Phuket", country: "Thailand", cc: "TH", lat: 8.113, lon: 98.317, tags: ["beach"] },
  SIN: { city: "Singapore", country: "Singapore", cc: "SG", lat: 1.364, lon: 103.991, tags: ["city"] },
  NRT: { city: "Tokyo Narita", country: "Japan", cc: "JP", lat: 35.772, lon: 140.393, tags: ["city"] },
  HND: { city: "Tokyo Haneda", country: "Japan", cc: "JP", lat: 35.549, lon: 139.780, tags: ["city"] },
  PEK: { city: "Beijing", country: "China", cc: "CN", lat: 40.080, lon: 116.585, tags: ["city"] },
  PVG: { city: "Shanghai", country: "China", cc: "CN", lat: 31.144, lon: 121.805, tags: ["city"] },
  HKG: { city: "Hong Kong", country: "Hong Kong", cc: "HK", lat: 22.308, lon: 113.918, tags: ["city"] },
  DEL: { city: "Delhi", country: "India", cc: "IN", lat: 28.556, lon: 77.100, tags: ["city"] },
  MLE: { city: "Maldives", country: "Maldives", cc: "MV", lat: 4.192, lon: 73.529, tags: ["beach"] },
  DXB: { city: "Dubai", country: "United Arab Emirates", cc: "AE", lat: 25.253, lon: 55.365, tags: ["city", "beach"] },
  DOH: { city: "Doha", country: "Qatar", cc: "QA", lat: 25.273, lon: 51.608, tags: ["city"] },
  TLV: { city: "Tel Aviv", country: "Israel", cc: "IL", lat: 32.011, lon: 34.887, tags: ["city", "beach"] },

  // ---- Africa ----
  CMN: { city: "Casablanca", country: "Morocco", cc: "MA", lat: 33.367, lon: -7.590, tags: ["city"] },
  RAK: { city: "Marrakesh", country: "Morocco", cc: "MA", lat: 31.607, lon: -8.036, tags: ["city"] },
  HRG: { city: "Hurghada", country: "Egypt", cc: "EG", lat: 27.178, lon: 33.799, tags: ["beach"] },
  SSH: { city: "Sharm el-Sheikh", country: "Egypt", cc: "EG", lat: 27.977, lon: 34.395, tags: ["beach"] },
  CAI: { city: "Cairo", country: "Egypt", cc: "EG", lat: 30.112, lon: 31.400, tags: ["city"] },
  CPT: { city: "Cape Town", country: "South Africa", cc: "ZA", lat: -33.965, lon: 18.602, tags: ["city", "beach", "nature"] },
  JNB: { city: "Johannesburg", country: "South Africa", cc: "ZA", lat: -26.139, lon: 28.246, tags: ["city"] },
};

/** Which broad part of the world a country sits in, for grouping. */
const REGION_BY_CC = {
  DK: "Nordics", SE: "Nordics", NO: "Nordics", FI: "Nordics", IS: "Nordics",
  EE: "Baltics", LV: "Baltics", LT: "Baltics",
  GB: "British Isles", IE: "British Isles",
  NL: "Western Europe", BE: "Western Europe", FR: "Western Europe", DE: "Western Europe",
  CH: "Western Europe", AT: "Western Europe",
  CZ: "Central Europe", PL: "Central Europe", HU: "Central Europe",
  RO: "Central Europe", BG: "Central Europe", HR: "Central Europe", ME: "Central Europe",
  ES: "Southern Europe", PT: "Southern Europe", IT: "Southern Europe",
  GR: "Southern Europe", CY: "Southern Europe", MT: "Southern Europe", TR: "Southern Europe",
  US: "North America", CA: "North America", MX: "North America",
  TH: "Asia", SG: "Asia", JP: "Asia", CN: "Asia", HK: "Asia", IN: "Asia", MV: "Asia",
  AE: "Middle East", QA: "Middle East", IL: "Middle East",
  MA: "Africa", EG: "Africa", ZA: "Africa",
};

const HOME = "CPH";

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in km. */
function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Estimated non-stop block time in hours. A lower bound: a connecting routing
 * takes longer, and nothing here knows which routing you would actually fly.
 */
function flightHours(code, { from = HOME } = {}) {
  const a = AIRPORTS[String(from).toUpperCase()];
  const b = AIRPORTS[String(code).toUpperCase()];
  if (!a || !b) return null;
  if (a === b) return 0;
  return GROUND_HOURS + distanceKm(a, b) / CRUISE_KMH;
}

/** Duration buckets, chosen around how a trip actually feels rather than round numbers. */
const BANDS = [
  { max: 2, label: "under 2h" },
  { max: 3.5, label: "2–3.5h" },
  { max: 5, label: "3.5–5h" },
  { max: 9, label: "5–9h" },
  { max: Infinity, label: "over 9h" },
];

function durationBand(hours) {
  if (hours === null || hours === undefined) return "unknown";
  return BANDS.find((b) => hours <= b.max).label;
}

/** Everything known about a code. Unknown codes degrade rather than throw. */
function place(code, { from = HOME } = {}) {
  const key = String(code || "").toUpperCase();
  const a = AIRPORTS[key];
  if (!a) {
    return {
      code: key, city: key, country: "Unknown", cc: null, region: "Unknown",
      tags: [], hours: null, band: "unknown", known: false,
    };
  }
  const hours = flightHours(key, { from });
  return {
    code: key, city: a.city, country: a.country, cc: a.cc,
    region: REGION_BY_CC[a.cc] || "Unknown",
    tags: a.tags, hours, band: durationBand(hours), known: true,
  };
}

/** Match a country by name or ISO code, case- and accent-insensitively enough. */
function matchesCountry(code, wanted) {
  if (!wanted) return true;
  const p = place(code);
  const w = String(wanted).trim().toLowerCase();
  return p.country.toLowerCase() === w || (p.cc || "").toLowerCase() === w;
}

function hasTag(code, tag) {
  if (!tag) return true;
  return place(code).tags.includes(String(tag).trim().toLowerCase());
}

/** Every tag in use, so the CLI can list them rather than hardcode a copy. */
function allTags() {
  const s = new Set();
  for (const a of Object.values(AIRPORTS)) for (const t of a.tags) s.add(t);
  return [...s].sort();
}

function allCountries() {
  return [...new Set(Object.values(AIRPORTS).map((a) => a.country))].sort();
}

module.exports = {
  place, flightHours, distanceKm, durationBand, matchesCountry, hasTag,
  allTags, allCountries, AIRPORTS, BANDS, HOME,
};

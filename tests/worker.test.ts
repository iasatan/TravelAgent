import test from "node:test";
import assert from "node:assert/strict";
import worker, { allowedOrigin, buildAirportNetwork, parseWorkerQuery } from "../worker/src/index.js";

test("airport network maps route codes to OurAirports coordinates and airlines", () => {
  const csv = [
    "ident,type,name,latitude_deg,longitude_deg,iso_country,municipality,scheduled_service,iata_code",
    'KJFK,large_airport,"John F. Kennedy International, Terminal 4",40.6413,-73.7781,US,"New York, NY",yes,JFK',
    "KLAX,large_airport,Los Angeles International,33.9416,-118.4085,US,Los Angeles,yes,LAX"
  ].join("\n");
  const data = buildAirportNetwork({ routes: [
    { from: "JFK", to: "LAX", airlines: ["AA", "JetBlue"] },
    { from: "JFK", to: "BAD", airlines: ["XX"] },
    { from: "invalid", to: "LAX", airlines: null }
  ] }, csv);
  assert.deepEqual(data.routes, [{ from: "JFK", to: "LAX", airlines: ["AA", "JetBlue"] }]);
  assert.equal(data.airports.find((airport) => airport.iata === "JFK")?.city, "New York, NY");
  assert.equal(data.airports.find((airport) => airport.iata === "JFK")?.longitude, -73.7781);
});

test("Worker validates IATA, month, year and airline query parameters", () => {
  const now = new Date("2026-11-13T00:00:00Z");
  assert.deepEqual(parseWorkerQuery(new URL("https://worker.test/api/destinations?from=BUD&year=2027&month=1&airlines=FR,W6"), now), {
    from: "BUD", year: 2027, month: 1, airlines: ["FR", "W6"], refresh: false
  });
  for (const query of ["from=BU&year=2027&month=1", "from=BUD&year=2027&month=13", "from=BUD&year=2035&month=1", "from=BUD&year=2027&month=1&airlines=bad!"]) {
    assert.equal(parseWorkerQuery(new URL(`https://worker.test/api/destinations?${query}`), now), null);
  }
  assert.equal(parseWorkerQuery(new URL("https://worker.test/api/destinations?from=BUD&year=2027&month=1&refresh=true"), now), null);
  assert.equal(parseWorkerQuery(new URL("https://worker.test/api/destinations?from=BUD&year=2027&month=1&refresh=1"), now)?.refresh, true);
});

test("Worker CORS accepts configured Pages and localhost origins only", () => {
  const env = { ALLOWED_ORIGINS: "https://example.github.io" };
  assert.equal(allowedOrigin("https://example.github.io", env), true);
  assert.equal(allowedOrigin("http://localhost:5173", env), true);
  assert.equal(allowedOrigin("https://attacker.example", env), false);
});

test("Worker answers preflight for an allowed origin", async () => {
  const response = await worker.fetch(new Request("https://worker.test/api/destinations", { method: "OPTIONS", headers: { Origin: "http://localhost:8000" } }), {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "http://localhost:8000");
});

test("Worker rejects arbitrary proxy paths and invalid parameters", async () => {
  const notFound = await worker.fetch(new Request("https://worker.test/?url=https://example.com"), {});
  assert.equal(notFound.status, 404);
  const badQuery = await worker.fetch(new Request("https://worker.test/api/destinations?from=bad&year=2027&month=1"), {});
  assert.equal(badQuery.status, 400);
  const badNetworkRefresh = await worker.fetch(new Request("https://worker.test/api/airport-network?refresh=true"), {});
  assert.equal(badNetworkRefresh.status, 400);
});
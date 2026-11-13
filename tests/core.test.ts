import test from "node:test";
import assert from "node:assert/strict";
import { FLIGHT_CACHE_TTL_MS, flightCacheKey, readFlightCache, writeFlightCache } from "../src/api.js";
import { AIRLINE_GROUPS, selectedAirlineCodes } from "../src/airports.js";
import { calculateMonthlyClimate, climateCacheKey, CLIMATE_TTL_MS, mapWithLimit, readClimateCache, writeClimateCache } from "../src/climate.js";
import { deduplicateRoutes, durationForRoute, estimatedDurationMinutes, filterRoutesByAirline, filterRoutesByAirlineGroups, haversineDistanceKm, parseRoutesResponse } from "../src/flights.js";
import { defaultSearch, durationMatches, parseSearchParams, serializeSearch, temperatureMatches } from "../src/state.js";
import type { Airport, FlightRoute } from "../src/types.js";

const bud: Airport = { iata: "BUD", name: "Budapest", city: "Budapest", country: "Hungary", latitude: 47.4369, longitude: 19.2556, timezone: "Europe/Budapest" };
const vie: Airport = { iata: "VIE", name: "Vienna", city: "Vienna", country: "Austria", latitude: 48.1103, longitude: 16.5697, timezone: "Europe/Vienna" };
const route = (overrides: Partial<FlightRoute> = {}): FlightRoute => ({ departureIata: "BUD", arrivalIata: "VIE", airlineIata: "FR", durationType: "unknown", scheduleVerified: false, ...overrides });

test("minimum temperature includes its exact boundary", () => assert.equal(temperatureMatches(18, { temperatureMode: "min", minTemp: 18 }), true));
test("minimum temperature rejects values below boundary", () => assert.equal(temperatureMatches(17.9, { temperatureMode: "min", minTemp: 18 }), false));
test("maximum temperature includes exact boundary but rejects 25.1", () => {
  assert.equal(temperatureMatches(25, { temperatureMode: "max", maxTemp: 25 }), true);
  assert.equal(temperatureMatches(25.1, { temperatureMode: "max", maxTemp: 25 }), false);
});
test("range accepts both boundaries and rejects out-of-range values", () => {
  const state = { temperatureMode: "range" as const, minTemp: 18, maxTemp: 24 };
  assert.equal(temperatureMatches(18, state), true);
  assert.equal(temperatureMatches(24, state), true);
  assert.equal(temperatureMatches(24.1, state), false);
});
test("monthly climate averages daily values for the requested month", () => {
  const result = calculateMonthlyClimate({
    time: ["2020-07-01", "2020-07-02", "2020-08-01"],
    temperature_2m_mean: [20, 22, 30],
    temperature_2m_max: [25, 27, 35]
  }, 7);
  assert.deepEqual(result, { mean: 21, max: 26, sampleCount: 2 });
});
test("monthly climate ignores missing values and reports no result without samples", () => {
  assert.deepEqual(calculateMonthlyClimate({ time: ["2020-01-01", "2020-01-02"], temperature_2m_mean: [null, 8], temperature_2m_max: [null, 10] }, 1), { mean: 8, max: 10, sampleCount: 1 });
  assert.equal(calculateMonthlyClimate({ time: ["2020-01-01"], temperature_2m_mean: [null], temperature_2m_max: [null] }, 1), null);
});
test("deduplication groups one destination and removes repeated codeshares", () => {
  const grouped = deduplicateRoutes([route(), route(), route({ airlineIata: "W6" }), route({ arrivalIata: "BUD" })]);
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get("VIE")?.length, 2);
});
test("airline filtering uses IATA codes and Wizz aliases are configurable", () => {
  assert.deepEqual(filterRoutesByAirline([route(), route({ airlineIata: "W6" })], ["W6"]).map((item) => item.airlineIata), ["W6"]);
  assert.deepEqual(AIRLINE_GROUPS.wizz, ["W6", "W9", "W4", "5W"]);
  assert.equal(selectedAirlineCodes(["ryanair", "wizz"])?.includes("FR"), true);
  assert.equal(selectedAirlineCodes(["other"]), undefined);
});
test("other airline group excludes configured airline aliases", () => {
  const routes = [route(), route({ airlineIata: "W6" }), route({ airlineIata: "U2" })];
  assert.deepEqual(filterRoutesByAirlineGroups(routes, ["other"]).map((item) => item.airlineIata), ["U2"]);
  assert.deepEqual(filterRoutesByAirlineGroups(routes, ["ryanair", "other"]).map((item) => item.airlineIata), ["FR", "U2"]);
  assert.deepEqual(filterRoutesByAirlineGroups(routes, ["ryanair", "wizz", "other"]), routes);
  assert.deepEqual(filterRoutesByAirlineGroups(routes, []), []);
});
test("duration filter includes 180 minutes and rejects 181", () => {
  assert.equal(durationMatches(180, 180), true);
  assert.equal(durationMatches(181, 180), false);
  assert.equal(durationMatches(undefined, 180), false);
  assert.equal(durationMatches(undefined, undefined), true);
});
test("offset timestamps produce scheduled duration across time zones", () => {
  const result = durationForRoute(route({ scheduledDeparture: "2026-07-01T10:00:00+02:00", scheduledArrival: "2026-07-01T11:00:00+01:00" }), bud, vie);
  assert.deepEqual(result, { minutes: 120, type: "scheduled" });
});
test("estimated duration and Haversine distance use great-circle coordinates", () => {
  const distance = haversineDistanceKm(bud, vie);
  assert.ok(distance > 200 && distance < 250);
  assert.equal(estimatedDurationMinutes(800), 90);
  assert.equal(durationForRoute(route(), bud, vie).type, "estimated");
});
test("query serialization round-trips search fields", () => {
  const initial = { ...defaultSearch(new Date("2026-06-15T12:00:00Z")), minTemp: 15, maxTemp: 24, maxFlightMinutes: 270, month: 8, year: 2026, airlines: ["wizz"], metric: "max" as const };
  const parsed = parseSearchParams(new URLSearchParams(serializeSearch(initial)), new Date("2026-06-15T12:00:00Z"));
  assert.deepEqual(parsed, initial);
  const noAirlines = { ...initial, airlines: [] };
  assert.deepEqual(parseSearchParams(new URLSearchParams(serializeSearch(noAirlines)), new Date("2026-06-15T12:00:00Z")), noAirlines);
});
test("invalid query values fall back safely", () => {
  const parsed = parseSearchParams(new URLSearchParams("from=BAD!&month=13&maxFlightMinutes=9999&airlines=nope"), new Date("2026-06-15T12:00:00Z"));
  assert.equal(parsed.from, "BUD");
  assert.equal(parsed.month, 7);
  assert.equal(parsed.maxFlightMinutes, 240);
});
test("climate cache expires after its TTL", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  const key = climateCacheKey("VIE", 8);
  const climate = { mean: 20, max: 25, sampleCount: 300 };
  writeClimateCache(storage, key, climate, 1000);
  assert.deepEqual(readClimateCache(storage, key, 1000 + CLIMATE_TTL_MS - 1), climate);
  assert.equal(readClimateCache(storage, key, 1000 + CLIMATE_TTL_MS), null);
});
test("malformed flight payload fails and invalid route rows are ignored", () => {
  assert.throws(() => parseRoutesResponse({ nope: [] }), /hibás választ/);
  assert.deepEqual(parseRoutesResponse({ routes: [null, {}, route()] }).length, 1);
});
test("climate failures are partial and concurrency is capped", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithLimit([0, 1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (value === 2) throw new Error("offline");
    return value;
  });
  assert.equal(peak, 2);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 5);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
});
test("monthly airline results are cached in localStorage for 14 days", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  const search = { ...defaultSearch(new Date("2026-06-15T12:00:00Z")), year: 2026, month: 8 };
  const key = flightCacheKey(search);
  const data = {
    routes: [{ departureIata: "BUD", arrivalIata: "VIE", airlineIata: "FR", durationType: "unknown" as const, scheduleVerified: true }],
    airports: [{ iata: "VIE", name: "Vienna", city: "Vienna", country: "Austria", latitude: 48.11, longitude: 16.56, timezone: "Europe/Vienna" }],
    providerErrors: []
  };
  writeFlightCache(storage, key, data, 5000);
  assert.deepEqual(readFlightCache(storage, key, 5000 + FLIGHT_CACHE_TTL_MS - 1), data);
  assert.equal(readFlightCache(storage, key, 5000 + FLIGHT_CACHE_TTL_MS), null);
  assert.notEqual(flightCacheKey({ ...search, month: 9 }), key);
});
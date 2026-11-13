const RYANAIR_FARES_URL = "https://www.ryanair.com/api/farfnd/3/oneWayFares";
const RYANAIR_AIRPORTS_URL = "https://www.ryanair.com/api/views/locate/5/airports/en/active";
const WIZZ_HOME_URL = "https://www.wizzair.com/en-gb";
const WIZZ_MAP_CACHE_KEY = "https://travel-agent-cache.invalid/wizz/map";
const WIZZ_BASE_CACHE_KEY = "https://travel-agent-cache.invalid/wizz/api-base";
const RESULT_CACHE_SECONDS = 14 * 24 * 60 * 60;
const REFERENCE_CACHE_SECONDS = 30 * 24 * 60 * 60;
const IATA_PATTERN = /^[A-Z]{3}$/;
const AIRLINE_PATTERN = /^[A-Z0-9]{2,3}$/;
const WIZZ_CODES = new Set(["W6", "W4", "W9", "5W"]);

export interface WorkerEnvironment {
  ALLOWED_ORIGINS?: string;
  WIZZ_API_BASE_URL?: string;
}

export interface WorkerSearch {
  from: string;
  year: number;
  month: number;
  airlines: string[];
  refresh: boolean;
}

export function parseWorkerQuery(url: URL, now = new Date()): WorkerSearch | null {
  const from = url.searchParams.get("from") ?? "";
  const month = Number(url.searchParams.get("month"));
  const year = Number(url.searchParams.get("year"));
  const airlineValue = url.searchParams.get("airlines") ?? "";
  if (!IATA_PATTERN.test(from) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year) || year < now.getFullYear() || year > now.getFullYear() + 2) return null;
  if (airlineValue.length > 100) return null;
  const airlines = airlineValue ? airlineValue.split(",") : [];
  if (airlines.some((code) => !AIRLINE_PATTERN.test(code))) return null;
  const refresh = url.searchParams.get("refresh");
  if (refresh !== null && refresh !== "1") return null;
  return { from, year, month, airlines: [...new Set(airlines)], refresh: refresh === "1" };
}

export function allowedOrigin(origin: string, env: WorkerEnvironment): boolean {
  if ([5173, 4173, 8000].some((port) => origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`)) return true;
  const configured = (env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return configured.includes(origin);
}

function responseHeaders(origin: string | null, env: WorkerEnvironment): Headers {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Vary": "Origin" });
  if (origin && allowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function jsonResponse(body: unknown, status: number, origin: string | null, env: WorkerEnvironment, extraHeaders?: HeadersInit): Response {
  const headers = responseHeaders(origin, env);
  new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

function workerCache(): Cache {
  return (globalThis.caches as CacheStorage & { default: Cache }).default;
}

async function cachedJson<T>(key: string, maxAge: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
  const cache = workerCache();
  const request = new Request(key);
  if (!refresh) {
    const cached = await cache.match(request);
    if (cached) return await cached.json() as T;
  }
  const value = await load();
  await cache.put(request, new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${maxAge}` }
  }));
  return value;
}

function setCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) return getSetCookie.call(headers);
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function mergeCookies(cookies: Map<string, string>, headers: Headers): void {
  for (const header of setCookieValues(headers)) {
    const pair = header.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (/max-age=0/i.test(header)) cookies.delete(name);
    else cookies.set(name, pair.slice(separator + 1).trim());
  }
}

function cookieHeader(cookies: Map<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function requestVerificationToken(cookies: Map<string, string>): string {
  const token = cookies.get("RequestVerificationToken");
  if (!token) throw new Error("Wizz session token is missing.");
  try { return decodeURIComponent(token); }
  catch { return token; }
}

async function discoverWizzApiBase(refresh: boolean, configuredBase?: string): Promise<string> {
  if (configuredBase) {
    if (!/^https:\/\/be\.wizzair\.com\/[0-9.]+\/Api$/i.test(configuredBase)) throw new Error("Invalid Wizz API base URL configuration.");
    return configuredBase;
  }
  return cachedJson(WIZZ_BASE_CACHE_KEY, REFERENCE_CACHE_SECONDS, refresh, async () => {
    const response = await fetch(WIZZ_HOME_URL, { headers: { Accept: "text/html" } });
    if (!response.ok) throw new Error(`Wizz homepage returned ${response.status}.`);
    const html = await response.text();
    const base = /https:\/\/be\.wizzair\.com\/[0-9.]+\/Api/i.exec(html)?.[0];
    if (!base) throw new Error("Could not find the Wizz API version in its homepage.");
    return base;
  });
}

async function createWizzSession(base: string, warmHomepage: boolean): Promise<Map<string, string>> {
  const cookies = new Map<string, string>();
  if (warmHomepage) {
    const home = await fetch(WIZZ_HOME_URL, { headers: { Accept: "text/html" } });
    if (!home.ok) throw new Error(`Wizz homepage returned ${home.status}.`);
    mergeCookies(cookies, home.headers);
  }
  const sessionHeaders = new Headers({ Origin: "https://www.wizzair.com", Referer: WIZZ_HOME_URL });
  if (cookies.size) sessionHeaders.set("Cookie", cookieHeader(cookies));
  const session = await fetch(`${base}/userSession/new`, {
    headers: sessionHeaders
  });
  mergeCookies(cookies, session.headers);
  if (!session.ok) throw new Error(`Wizz session setup returned ${session.status}.`);
  requestVerificationToken(cookies);
  return cookies;
}

async function wizzRequest(base: string, cookies: Map<string, string>, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Cookie", cookieHeader(cookies));
  headers.set("X-RequestVerificationToken", requestVerificationToken(cookies));
  headers.set("Origin", "https://www.wizzair.com");
  headers.set("Referer", WIZZ_HOME_URL);
  const response = await fetch(`${base}/${path}`, { ...init, headers });
  mergeCookies(cookies, response.headers);
  return response;
}

interface AirlineAirport {
  iata: string;
  name: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

interface NormalizedRoute {
  departureIata: string;
  arrivalIata: string;
  airlineIata: string;
  flightNumber?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
  durationType: "unknown";
  scheduleVerified: boolean;
}

interface ProviderData {
  routes: NormalizedRoute[];
  airports: Map<string, AirlineAirport>;
}

function normalizeRyanairAirports(payload: unknown): Map<string, AirlineAirport> {
  const airports = new Map<string, AirlineAirport>();
  if (!Array.isArray(payload)) throw new Error("Ryanair airport response is malformed.");
  for (const item of payload) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const coordinates = row.coordinates as Record<string, unknown> | undefined;
    const city = row.city as Record<string, unknown> | undefined;
    const country = row.country as Record<string, unknown> | undefined;
    if (typeof row.code !== "string" || !IATA_PATTERN.test(row.code)
      || typeof row.name !== "string" || typeof city?.name !== "string" || typeof country?.name !== "string"
      || typeof coordinates?.latitude !== "number" || typeof coordinates.longitude !== "number"
      || typeof row.timeZone !== "string") continue;
    airports.set(row.code, {
      iata: row.code,
      name: row.name,
      city: city.name,
      country: country.name,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      timezone: row.timeZone
    });
  }
  return airports;
}

async function getRyanairAirports(refresh: boolean): Promise<Map<string, AirlineAirport>> {
  const rows = await cachedJson<unknown>("https://travel-agent-cache.invalid/ryanair/airports", REFERENCE_CACHE_SECONDS, refresh, async () => {
    const response = await fetch(RYANAIR_AIRPORTS_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Ryanair airport data returned ${response.status}.`);
    return response.json();
  });
  return normalizeRyanairAirports(rows);
}

function monthDateRange(year: number, month: number): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  return { from: `${prefix}-01`, to: `${prefix}-${String(lastDay).padStart(2, "0")}` };
}

async function getRyanairData(search: WorkerSearch): Promise<ProviderData> {
  const airports = await getRyanairAirports(search.refresh);
  const dates = monthDateRange(search.year, search.month);
  const url = new URL(RYANAIR_FARES_URL);
  url.search = new URLSearchParams({
    departureAirportIataCode: search.from,
    outboundDepartureDateFrom: dates.from,
    outboundDepartureDateTo: dates.to,
    market: "en-gb",
    adultPaxCount: "1"
  }).toString();
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Ryanair monthly search returned ${response.status}.`);
  const payload = await response.json() as { fares?: unknown };
  if (!Array.isArray(payload.fares)) throw new Error("Ryanair fare response is malformed.");
  const routes: NormalizedRoute[] = [];
  for (const fare of payload.fares) {
    if (typeof fare !== "object" || fare === null) continue;
    const outbound = (fare as Record<string, unknown>).outbound as Record<string, unknown> | undefined;
    const departureAirport = outbound?.departureAirport as Record<string, unknown> | undefined;
    const arrivalAirport = outbound?.arrivalAirport as Record<string, unknown> | undefined;
    const departure = departureAirport?.iataCode;
    const arrival = arrivalAirport?.iataCode;
    const flightNumber = outbound?.flightNumber;
    if (departure !== search.from || typeof arrival !== "string" || !IATA_PATTERN.test(arrival)
      || typeof flightNumber !== "string" || !flightNumber.startsWith("FR")) continue;
    routes.push({
      departureIata: search.from,
      arrivalIata: arrival,
      airlineIata: "FR",
      flightNumber,
      ...(typeof outbound?.departureDate === "string" ? { scheduledDeparture: outbound.departureDate } : {}),
      ...(typeof outbound?.arrivalDate === "string" ? { scheduledArrival: outbound.arrivalDate } : {}),
      durationType: "unknown",
      scheduleVerified: true
    });
  }
  return { routes, airports };
}

interface WizzCity extends Record<string, unknown> {
  iata?: string;
  shortName?: string;
  countryName?: string;
  latitude?: number;
  longitude?: number;
  connections?: Array<Record<string, unknown>>;
}

async function getWizzMap(base: string, refresh: boolean, cookies: Map<string, string>): Promise<WizzCity[]> {
  return cachedJson(WIZZ_MAP_CACHE_KEY, REFERENCE_CACHE_SECONDS, refresh, async () => {
    const response = await wizzRequest(base, cookies, "asset/map?languageCode=en-gb");
    if (!response.ok) throw new Error(`Wizz route map returned ${response.status}.`);
    const payload = await response.json() as { cities?: unknown };
    if (!Array.isArray(payload.cities)) throw new Error("Wizz route map is malformed.");
    return payload.cities as WizzCity[];
  });
}

function normalizeWizzAirport(city: WizzCity): AirlineAirport | null {
  if (typeof city.iata !== "string" || !IATA_PATTERN.test(city.iata)
    || typeof city.shortName !== "string" || typeof city.countryName !== "string"
    || typeof city.latitude !== "number" || typeof city.longitude !== "number") return null;
  return {
    iata: city.iata,
    name: city.shortName,
    city: city.shortName,
    country: city.countryName,
    latitude: city.latitude,
    longitude: city.longitude,
    timezone: "auto"
  };
}

async function getWizzData(search: WorkerSearch, env: WorkerEnvironment): Promise<ProviderData> {
  const base = await discoverWizzApiBase(search.refresh, env.WIZZ_API_BASE_URL);
  const cookies = await createWizzSession(base, !env.WIZZ_API_BASE_URL);
  const cities = await getWizzMap(base, search.refresh, cookies);
  const origin = cities.find((city) => city.iata === search.from);
  if (!origin) throw new Error("Origin airport is not in the Wizz network map.");
  const destinations = [...new Set((origin.connections ?? [])
    .filter((connection) => connection.isDirectFlight === true && connection.isConnected !== true)
    .map((connection) => connection.iata)
    .filter((iata): iata is string => typeof iata === "string" && IATA_PATTERN.test(iata)))];
  const dateRange = monthDateRange(search.year, search.month);
  const batches: string[][] = [];
  for (let index = 0; index < destinations.length; index += 5) batches.push(destinations.slice(index, index + 5));
  const routes = await batches.reduce(async (previousRoutes, batch) => [
    ...await previousRoutes,
    ...await loadWizzBatch(base, cookies, search.from, dateRange, batch)
  ], Promise.resolve([] as NormalizedRoute[]));
  const airports = new Map<string, AirlineAirport>();
  for (const city of cities) {
    const airport = normalizeWizzAirport(city);
    if (airport) airports.set(airport.iata, airport);
  }
  return { routes, airports };
}

async function loadWizzBatch(base: string, cookies: Map<string, string>, departure: string, dates: { from: string; to: string }, arrivals: string[]): Promise<NormalizedRoute[]> {
  const response = await wizzRequest(base, cookies, "search/FlightDatesMultiArrival", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ departureStation: departure, arrivalStations: arrivals, ...dates })
  });
  if (!response.ok) throw new Error(`Wizz monthly schedule returned ${response.status}.`);
  const payload = await response.json() as { arrivalStationResults?: unknown; isArrivalLimitExceeded?: unknown };
  if (payload.isArrivalLimitExceeded === true || typeof payload.arrivalStationResults !== "object" || payload.arrivalStationResults === null) {
    throw new Error("Wizz rejected a monthly destination batch.");
  }
  const schedules = payload.arrivalStationResults as Record<string, unknown>;
  return arrivals.flatMap((arrival) => {
    const schedule = Object.entries(schedules).find(([key]) => key.toUpperCase() === `${departure}-${arrival}`)?.[1];
    return Array.isArray(schedule) && schedule.length
      ? [{ departureIata: departure, arrivalIata: arrival, airlineIata: "W6", durationType: "unknown" as const, scheduleVerified: true }]
      : [];
  });
}

async function loadFlightData(search: WorkerSearch, env: WorkerEnvironment): Promise<{ routes: NormalizedRoute[]; airports: AirlineAirport[]; providerErrors: string[] }> {
  const wantsRyanair = search.airlines.includes("FR");
  const wantsWizz = search.airlines.some((code) => WIZZ_CODES.has(code));
  const tasks: Array<{ name: string; load: () => Promise<ProviderData> }> = [];
  if (wantsRyanair) tasks.push({ name: "Ryanair", load: () => getRyanairData(search) });
  if (wantsWizz) tasks.push({ name: "Wizz Air", load: () => getWizzData(search, env) });
  const outcomes = await Promise.all(tasks.map(async (task) => {
    try { return { name: task.name, data: await task.load() }; }
    catch (error) { return { name: task.name, data: null, error: error instanceof Error ? error.message : "Unknown upstream error." }; }
  }));
  const routes: NormalizedRoute[] = [];
  const airports = new Map<string, AirlineAirport>();
  const providerErrors: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.data) {
      providerErrors.push(`${outcome.name} átmenetileg nem érhető el (${outcome.error ?? "upstream error"}).`);
      continue;
    }
    routes.push(...outcome.data.routes);
    for (const [iata, airport] of outcome.data.airports) {
      if (!airports.has(iata) || airport.timezone !== "auto") airports.set(iata, airport);
    }
  }
  return { routes, airports: [...airports.values()], providerErrors };
}

export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const baseHeaders = responseHeaders(origin, env);
    if (request.method === "OPTIONS") {
      if (origin && !allowedOrigin(origin, env)) return jsonResponse({ error: "Origin is not allowed." }, 403, null, env);
      return new Response(null, { status: 204, headers: baseHeaders });
    }
    if (request.method !== "GET" || url.pathname !== "/api/destinations") {
      return jsonResponse({ error: "Not found." }, 404, origin, env);
    }
    if (origin && !allowedOrigin(origin, env)) return jsonResponse({ error: "Origin is not allowed." }, 403, null, env);
    const search = parseWorkerQuery(url);
    if (!search) return jsonResponse({ error: "Invalid search parameters." }, 400, origin, env);
    const cache = workerCache();
    const cacheQuery = new URLSearchParams({ from: search.from, year: String(search.year), month: String(search.month), airlines: search.airlines.join(",") });
    const cacheKey = new Request(`https://travel-agent-cache.invalid/destinations?${cacheQuery}`);
    if (!search.refresh) {
      const cached = await cache.match(cacheKey);
      if (cached) return jsonResponse(await cached.json(), 200, origin, env, { "Cache-Control": `public, max-age=${RESULT_CACHE_SECONDS}` });
    }
    const data = await loadFlightData(search, env);
    if (data.providerErrors.length && data.providerErrors.length === Number(search.airlines.includes("FR")) + Number(search.airlines.some((code) => WIZZ_CODES.has(code)))) {
      return jsonResponse({ error: data.providerErrors.join(" ") }, 502, origin, env, { "Cache-Control": "no-store" });
    }
    const included = new Set([search.from, ...data.routes.map((route) => route.arrivalIata)]);
    const result = { routes: data.routes, airports: data.airports.filter((airport) => included.has(airport.iata)), providerErrors: data.providerErrors };
    if (!result.providerErrors.length) {
      await cache.put(cacheKey, new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${RESULT_CACHE_SECONDS}` }
      }));
    }
    return jsonResponse(result, 200, origin, env, { "Cache-Control": `public, max-age=${RESULT_CACHE_SECONDS}` });
  }
};
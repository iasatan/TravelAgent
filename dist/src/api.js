import { parseRoutesResponse } from "./flights.js";
import { AIRLINE_GROUPS } from "./airports.js";
export const FLIGHT_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FLIGHT_CACHE_PREFIX = "travel-agent:flights:v1:";
export function flightCacheKey(search) {
    return `${FLIGHT_CACHE_PREFIX}${search.from}:${search.year}-${search.month}:${[...search.airlines].sort((a, b) => a.localeCompare(b)).join(",")}`;
}
export function readFlightCache(storage, key, now = Date.now()) {
    try {
        const raw = storage.getItem(key);
        if (!raw)
            return null;
        const entry = JSON.parse(raw);
        if (typeof entry.expiresAt !== "number" || entry.expiresAt <= now || typeof entry.data !== "object" || entry.data === null)
            return null;
        return normalizeFlightSearchData(entry.data);
    }
    catch {
        return null;
    }
}
export function writeFlightCache(storage, key, data, now = Date.now()) {
    try {
        storage.setItem(key, JSON.stringify({ expiresAt: now + FLIGHT_CACHE_TTL_MS, data }));
    }
    catch {
        // Search results remain usable when browser storage is disabled or full.
    }
}
export function normalizeFlightSearchData(payload) {
    const routes = parseRoutesResponse(payload);
    if (typeof payload !== "object" || payload === null)
        throw new Error("A járat API hibás választ adott.");
    const airports = Array.isArray(payload.airports)
        ? payload.airports.flatMap(normalizeAirport)
        : [];
    const errors = payload.providerErrors;
    return {
        routes,
        airports,
        providerErrors: Array.isArray(errors) ? errors.filter((error) => typeof error === "string") : []
    };
}
function normalizeAirport(value) {
    if (typeof value !== "object" || value === null)
        return [];
    const airport = value;
    if (typeof airport.iata !== "string" || !/^[A-Z]{3}$/.test(airport.iata)
        || typeof airport.name !== "string" || typeof airport.city !== "string" || typeof airport.country !== "string"
        || typeof airport.timezone !== "string" || typeof airport.latitude !== "number" || !Number.isFinite(airport.latitude)
        || typeof airport.longitude !== "number" || !Number.isFinite(airport.longitude))
        return [];
    return [{
            iata: airport.iata,
            name: airport.name,
            city: airport.city,
            country: airport.country,
            latitude: airport.latitude,
            longitude: airport.longitude,
            timezone: airport.timezone
        }];
}
function safeStorage() {
    try {
        return localStorage;
    }
    catch {
        return null;
    }
}
export async function getDestinations(search, signal, refresh = false) {
    const configuredUrl = document.querySelector('meta[name="travel-agent-api"]')?.content.trim();
    if (!configuredUrl)
        throw new Error("A repülési API még nincs konfigurálva. Állítsd be a Cloudflare Worker URL-jét az index.html meta tagjében.");
    const cacheKey = flightCacheKey(search);
    const storage = safeStorage();
    const cached = !refresh && storage ? readFlightCache(storage, cacheKey) : null;
    if (cached)
        return cached;
    const airlines = [...new Set(search.airlines.flatMap((group) => AIRLINE_GROUPS[group] ?? []))];
    if (!airlines.length)
        return { routes: [], airports: [], providerErrors: [] };
    const url = new URL("/api/destinations", configuredUrl);
    const query = new URLSearchParams({
        from: search.from,
        year: String(search.year),
        month: String(search.month),
        airlines: airlines.join(",")
    });
    if (refresh)
        query.set("refresh", "1");
    url.search = query.toString();
    const response = await fetch(url, { signal, cache: refresh ? "no-store" : "default" });
    if (!response.ok) {
        const message = response.status === 429 ? "A járatforrás elérte a lekérési korlátot. Próbáld újra később." : `A járatok lekérése sikertelen (${response.status}).`;
        if (response.status === 503)
            throw new Error("A légitársaságok adatforrásai átmenetileg nem érhetők el.");
        throw new Error(message);
    }
    const data = normalizeFlightSearchData(await response.json());
    if (storage && !data.providerErrors.length)
        writeFlightCache(storage, cacheKey, data);
    return data;
}

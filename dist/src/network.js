export const AIRPORT_NETWORK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AIRPORT_NETWORK_CACHE_KEY = "travel-agent:airport-network:v1";
const AIRPORTMILES_ROUTES_URL = "https://airportmiles.com/api/v1/routes.json";
const OURAIRPORTS_CSV_URL = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";
export function normalizeAirportNetwork(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const data = value;
    if (!Array.isArray(data.airports) || !Array.isArray(data.routes))
        return null;
    const airports = data.airports.flatMap((item) => {
        if (typeof item !== "object" || item === null)
            return [];
        const airport = item;
        if (typeof airport.iata !== "string" || !/^[A-Z]{3}$/.test(airport.iata)
            || typeof airport.name !== "string" || typeof airport.city !== "string" || typeof airport.country !== "string"
            || typeof airport.latitude !== "number" || !Number.isFinite(airport.latitude)
            || typeof airport.longitude !== "number" || !Number.isFinite(airport.longitude))
            return [];
        return [{
                iata: airport.iata,
                name: airport.name,
                city: airport.city,
                country: airport.country,
                latitude: airport.latitude,
                longitude: airport.longitude,
                timezone: typeof airport.timezone === "string" ? airport.timezone : "auto"
            }];
    });
    const routes = data.routes.flatMap((item) => {
        if (typeof item !== "object" || item === null)
            return [];
        const route = item;
        if (typeof route.from !== "string" || !/^[A-Z]{3}$/.test(route.from)
            || typeof route.to !== "string" || !/^[A-Z]{3}$/.test(route.to))
            return [];
        return [{ from: route.from, to: route.to, airlines: Array.isArray(route.airlines)
                    ? route.airlines.filter((airline) => typeof airline === "string") : [] }];
    });
    return { airports, routes };
}
export function readAirportNetworkCache(storage, now = Date.now()) {
    try {
        const raw = storage.getItem(AIRPORT_NETWORK_CACHE_KEY);
        if (!raw)
            return null;
        const entry = JSON.parse(raw);
        if (typeof entry.expiresAt !== "number" || entry.expiresAt <= now)
            return null;
        return normalizeAirportNetwork(entry.data);
    }
    catch {
        return null;
    }
}
export function writeAirportNetworkCache(storage, data, now = Date.now()) {
    try {
        storage.setItem(AIRPORT_NETWORK_CACHE_KEY, JSON.stringify({ expiresAt: now + AIRPORT_NETWORK_TTL_MS, data }));
    }
    catch {
        return;
    }
}
function parseCsvLine(line) {
    const fields = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') {
                field += '"';
                index += 1;
            }
            else
                quoted = !quoted;
        }
        else if (character === "," && !quoted) {
            fields.push(field);
            field = "";
        }
        else
            field += character;
    }
    fields.push(field);
    return fields;
}
function airportTypeRank(type) {
    if (type === "large_airport")
        return 3;
    if (type === "medium_airport")
        return 2;
    return 1;
}
function parseAirportCsv(csv, codes) {
    const lines = csv.split(/\r?\n/);
    const columns = new Map(parseCsvLine(lines.shift() ?? "").map((name, index) => [name, index]));
    const airports = new Map();
    for (const line of lines) {
        if (!line)
            continue;
        const row = parseCsvLine(line);
        const value = (name) => row[columns.get(name) ?? -1] ?? "";
        const iata = value("iata_code");
        if (!codes.has(iata))
            continue;
        const latitude = Number(value("latitude_deg"));
        const longitude = Number(value("longitude_deg"));
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
            continue;
        const name = value("name") || iata;
        const airport = {
            iata,
            name,
            city: value("municipality") || name,
            country: value("iso_country") || "Unknown",
            latitude,
            longitude,
            timezone: "auto"
        };
        const rank = airportTypeRank(value("type")) + (value("scheduled_service") === "yes" ? 10 : 0);
        const previous = airports.get(iata);
        if (!previous || previous.rank < rank)
            airports.set(iata, { airport, rank });
    }
    return [...airports.values()].map(({ airport }) => airport);
}
async function fetchAirportNetworkDirect(signal) {
    const [routesResponse, airportsResponse] = await Promise.all([
        fetch(AIRPORTMILES_ROUTES_URL, { signal, headers: { Accept: "application/json" } }),
        fetch(OURAIRPORTS_CSV_URL, { signal, headers: { Accept: "text/csv" } })
    ]);
    if (!routesResponse.ok)
        throw new Error(`AirportMiles routes returned ${routesResponse.status}.`);
    if (!airportsResponse.ok)
        throw new Error(`OurAirports data returned ${airportsResponse.status}.`);
    const routePayload = await routesResponse.json();
    const normalizedRoutes = normalizeAirportNetwork({ airports: [], routes: routePayload.routes });
    if (!normalizedRoutes)
        throw new Error("AirportMiles route response is malformed.");
    const airportCodes = new Set(normalizedRoutes.routes.flatMap((route) => [route.from, route.to]));
    const airports = parseAirportCsv(await airportsResponse.text(), airportCodes);
    const availableCodes = new Set(airports.map((airport) => airport.iata));
    return { airports, routes: normalizedRoutes.routes.filter((route) => availableCodes.has(route.from) && availableCodes.has(route.to)) };
}
export async function getAirportNetwork(apiBase, storage, signal, refresh = false) {
    const cached = !refresh ? readAirportNetworkCache(storage) : null;
    if (cached)
        return cached;
    const url = new URL("/api/airport-network", apiBase);
    if (refresh)
        url.searchParams.set("refresh", "1");
    let data = null;
    try {
        const response = await fetch(url, { signal, cache: refresh ? "no-store" : "default" });
        if (response.ok)
            data = normalizeAirportNetwork(await response.json());
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
    }
    if (!data?.airports.length)
        data = await fetchAirportNetworkDirect(signal);
    if (!data?.airports.length)
        throw new Error("A repülőtér-hálózat hibás választ adott.");
    writeAirportNetworkCache(storage, data);
    return data;
}

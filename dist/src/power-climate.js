import { mapWithLimit } from "./climate.js";
export const POWER_CLIMATE_START_YEAR = 2001;
export const POWER_CLIMATE_END_YEAR = 2025;
export const POWER_CLIMATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "travel-agent:climate-power:v1:";
const POWER_URL = "https://power.larc.nasa.gov/api/temporal/monthly/point";
const PARAMETERS = "T2M,T2M_MAX,T2M_MIN";
export function powerClimateCacheKey(iata, month) {
    return `${CACHE_PREFIX}${iata}:${month}:${POWER_CLIMATE_START_YEAR}-${POWER_CLIMATE_END_YEAR}`;
}
function monthlyAverage(parameter, month) {
    if (typeof parameter !== "object" || parameter === null)
        return { value: null, count: 0 };
    const values = Object.entries(parameter).flatMap(([date, value]) => {
        if (!/^\d{6}$/.test(date) || Number(date.slice(4)) !== month || typeof value !== "number" || !Number.isFinite(value) || value <= -900)
            return [];
        return [value];
    });
    if (!values.length)
        return { value: null, count: 0 };
    return { value: values.reduce((total, value) => total + value, 0) / values.length, count: values.length };
}
export function parsePowerMonthlyClimate(payload, month) {
    if (typeof payload !== "object" || payload === null)
        return null;
    const properties = payload.properties;
    if (typeof properties !== "object" || properties === null)
        return null;
    const parameters = properties.parameter;
    if (typeof parameters !== "object" || parameters === null)
        return null;
    const values = parameters;
    const mean = monthlyAverage(values.T2M, month);
    const maximum = monthlyAverage(values.T2M_MAX, month);
    const minimum = monthlyAverage(values.T2M_MIN, month);
    if (!mean.count && !maximum.count && !minimum.count)
        return null;
    return {
        mean: mean.value,
        max: maximum.value,
        min: minimum.value,
        sampleCount: Math.max(mean.count, maximum.count, minimum.count)
    };
}
export function readPowerClimateCache(storage, key, now = Date.now()) {
    try {
        const raw = storage.getItem(key);
        if (!raw)
            return null;
        const entry = JSON.parse(raw);
        if (typeof entry.expiresAt !== "number" || entry.expiresAt <= now || typeof entry.value !== "object" || entry.value === null)
            return null;
        const value = entry.value;
        const validTemperatures = [value.mean, value.max, value.min].every((temperature) => temperature === null || (typeof temperature === "number" && Number.isFinite(temperature)));
        if (!validTemperatures || !Number.isFinite(value.sampleCount))
            return null;
        return value;
    }
    catch {
        return null;
    }
}
export function writePowerClimateCache(storage, key, value, now = Date.now()) {
    try {
        storage.setItem(key, JSON.stringify({ expiresAt: now + POWER_CLIMATE_TTL_MS, value }));
    }
    catch {
        return;
    }
}
async function fetchAirportPowerClimate(airport, month, signal) {
    const url = new URL(POWER_URL);
    url.search = new URLSearchParams({
        parameters: PARAMETERS,
        community: "RE",
        longitude: String(airport.longitude),
        latitude: String(airport.latitude),
        start: String(POWER_CLIMATE_START_YEAR),
        end: String(POWER_CLIMATE_END_YEAR),
        format: "JSON"
    }).toString();
    const response = await fetch(url, { signal });
    if (!response.ok) {
        const error = new Error(`Klímaadat-lekérés sikertelen (${response.status}).`);
        Object.assign(error, { status: response.status });
        throw error;
    }
    const climate = parsePowerMonthlyClimate(await response.json(), month);
    if (!climate)
        throw new Error(`A NASA POWER nem adott havi klímaadatot (${airport.iata}).`);
    return climate;
}
export async function fetchPowerMonthlyClimateBatch(airports, month, signal) {
    const outcomes = await mapWithLimit(airports, 4, (airport) => fetchAirportPowerClimate(airport, month, signal));
    const climates = new Map();
    let failedCount = 0;
    let rateLimited = false;
    for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === "rejected") {
            failedCount += 1;
            rateLimited ||= typeof outcome.reason === "object" && outcome.reason !== null && "status" in outcome.reason && outcome.reason.status === 429;
            continue;
        }
        climates.set(airports[index].iata, outcome.value);
    }
    return { climates, failedCount, rateLimited };
}

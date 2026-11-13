export const CLIMATE_START_YEAR = 2015;
export const CLIMATE_END_YEAR = 2025;
export const CLIMATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "travel-agent:climate:v1:";
function averageSeriesForMonth(dates, series, month) {
    if (!Array.isArray(series))
        return { value: null, count: 0 };
    const values = dates.flatMap((date, index) => {
        const value = series[index];
        return typeof date === "string" && Number(date.slice(5, 7)) === month
            && typeof value === "number" && Number.isFinite(value) ? [value] : [];
    });
    if (!values.length)
        return { value: null, count: 0 };
    return { value: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length };
}
export function calculateMonthlyClimate(data, month) {
    if (!Array.isArray(data.time))
        return null;
    const mean = averageSeriesForMonth(data.time, data.temperature_2m_mean, month);
    const maximum = averageSeriesForMonth(data.time, data.temperature_2m_max, month);
    const minimum = averageSeriesForMonth(data.time, data.temperature_2m_min, month);
    if (!mean.count && !maximum.count && !minimum.count)
        return null;
    return {
        mean: mean.value,
        max: maximum.value,
        min: minimum.value,
        sampleCount: Math.max(mean.count, maximum.count, minimum.count)
    };
}
export function climateCacheKey(iata, month) {
    return `travel-agent:climate:v2:${iata}:${month}:${CLIMATE_START_YEAR}-${CLIMATE_END_YEAR}`;
}
export function readClimateCache(storage, key, now = Date.now()) {
    try {
        const raw = storage.getItem(key);
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now || !parsed.value)
            return null;
        const validTemperatures = [parsed.value.mean, parsed.value.max, parsed.value.min].every((value) => value === null || (typeof value === "number" && Number.isFinite(value)));
        if (!validTemperatures || !Number.isFinite(parsed.value.sampleCount))
            return null;
        return parsed.value;
    }
    catch {
        return null;
    }
}
export function writeClimateCache(storage, key, value, now = Date.now()) {
    try {
        storage.setItem(key, JSON.stringify({ expiresAt: now + CLIMATE_TTL_MS, value }));
    }
    catch {
        // Storage can be disabled or full; climate results remain usable for this search.
    }
}
export async function fetchMonthlyClimateBatch(airports, month, signal) {
    if (!airports.length)
        return new Map();
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.search = new URLSearchParams({
        latitude: airports.map((airport) => String(airport.latitude)).join(","),
        longitude: airports.map((airport) => String(airport.longitude)).join(","),
        start_date: `${CLIMATE_START_YEAR}-01-01`,
        end_date: `${CLIMATE_END_YEAR}-12-31`,
        daily: "temperature_2m_mean,temperature_2m_max,temperature_2m_min",
        timezone: "auto"
    }).toString();
    const response = await fetch(url, { signal });
    if (!response.ok) {
        const error = new Error(`Klímaadat-lekérés sikertelen (${response.status}).`);
        Object.assign(error, { status: response.status });
        throw error;
    }
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : [payload];
    if (items.length !== airports.length)
        throw new Error("A klíma API eltérő számú reptéradatot adott vissza.");
    const results = new Map();
    for (const [index, item] of items.entries()) {
        const climate = item.daily ? calculateMonthlyClimate(item.daily, month) : null;
        if (climate)
            results.set(airports[index].iata, climate);
    }
    return results;
}
export async function mapWithLimit(items, limit, task) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function processNext() {
        const index = nextIndex++;
        if (index >= items.length)
            return;
        try {
            results[index] = { status: "fulfilled", value: await task(items[index]) };
        }
        catch (reason) {
            results[index] = { status: "rejected", reason };
        }
        return processNext();
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => processNext()));
    return results;
}

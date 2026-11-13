export const CLIMATE_START_YEAR = 2015;
export const CLIMATE_END_YEAR = 2025;
export const CLIMATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "travel-agent:climate:v1:";
export function calculateMonthlyClimate(data, month) {
    if (!Array.isArray(data.time) || !Array.isArray(data.temperature_2m_mean) || !Array.isArray(data.temperature_2m_max))
        return null;
    const meanValues = [];
    const maxValues = [];
    for (let index = 0; index < data.time.length; index += 1) {
        const date = data.time[index];
        if (typeof date !== "string" || Number(date.slice(5, 7)) !== month)
            continue;
        const mean = data.temperature_2m_mean[index];
        const maximum = data.temperature_2m_max[index];
        if (typeof mean === "number" && Number.isFinite(mean))
            meanValues.push(mean);
        if (typeof maximum === "number" && Number.isFinite(maximum))
            maxValues.push(maximum);
    }
    if (!meanValues.length || !maxValues.length)
        return null;
    return {
        mean: meanValues.reduce((sum, value) => sum + value, 0) / meanValues.length,
        max: maxValues.reduce((sum, value) => sum + value, 0) / maxValues.length,
        sampleCount: Math.min(meanValues.length, maxValues.length)
    };
}
export function climateCacheKey(iata, month) {
    return `${CACHE_PREFIX}${iata}:${month}:${CLIMATE_START_YEAR}-${CLIMATE_END_YEAR}`;
}
export function readClimateCache(storage, key, now = Date.now()) {
    try {
        const raw = storage.getItem(key);
        if (!raw)
            return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now || !parsed.value)
            return null;
        if (![parsed.value.mean, parsed.value.max, parsed.value.sampleCount].every(Number.isFinite))
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
export async function fetchMonthlyClimate(airport, month, signal) {
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.search = new URLSearchParams({
        latitude: String(airport.latitude),
        longitude: String(airport.longitude),
        start_date: `${CLIMATE_START_YEAR}-01-01`,
        end_date: `${CLIMATE_END_YEAR}-12-31`,
        daily: "temperature_2m_mean,temperature_2m_max",
        timezone: airport.timezone
    }).toString();
    const response = await fetch(url, { signal });
    if (!response.ok) {
        const error = new Error(`Klímaadat-lekérés sikertelen (${response.status}).`);
        Object.assign(error, { status: response.status });
        throw error;
    }
    const payload = await response.json();
    const climate = payload.daily ? calculateMonthlyClimate(payload.daily, month) : null;
    if (!climate)
        throw new Error("Ehhez a repülőtérhez nem érhető el teljes klímaadat.");
    return climate;
}
export async function mapWithLimit(items, limit, task) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length)
                return;
            try {
                results[index] = { status: "fulfilled", value: await task(items[index]) };
            }
            catch (reason) {
                results[index] = { status: "rejected", reason };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()));
    return results;
}

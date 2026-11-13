import type { Airport, MonthlyClimate } from "./types.js";

export const CLIMATE_START_YEAR = 2015;
export const CLIMATE_END_YEAR = 2025;
export const CLIMATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "travel-agent:climate:v1:";

interface DailyData {
  time?: unknown;
  temperature_2m_mean?: unknown;
  temperature_2m_max?: unknown;
  temperature_2m_min?: unknown;
}

interface MonthlyAverage {
  value: number | null;
  count: number;
}

function averageSeriesForMonth(dates: unknown[], series: unknown, month: number): MonthlyAverage {
  if (!Array.isArray(series)) return { value: null, count: 0 };
  const values = dates.flatMap((date, index) => {
    const value = series[index];
    return typeof date === "string" && Number(date.slice(5, 7)) === month
      && typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
  if (!values.length) return { value: null, count: 0 };
  return { value: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length };
}

export function calculateMonthlyClimate(data: DailyData, month: number): MonthlyClimate | null {
  if (!Array.isArray(data.time)) return null;
  const mean = averageSeriesForMonth(data.time, data.temperature_2m_mean, month);
  const maximum = averageSeriesForMonth(data.time, data.temperature_2m_max, month);
  const minimum = averageSeriesForMonth(data.time, data.temperature_2m_min, month);
  if (!mean.count && !maximum.count && !minimum.count) return null;
  return {
    mean: mean.value,
    max: maximum.value,
    min: minimum.value,
    sampleCount: Math.max(mean.count, maximum.count, minimum.count)
  };
}

export function climateCacheKey(iata: string, month: number): string {
  return `travel-agent:climate:v2:${iata}:${month}:${CLIMATE_START_YEAR}-${CLIMATE_END_YEAR}`;
}

export function readClimateCache(storage: Pick<Storage, "getItem">, key: string, now = Date.now()): MonthlyClimate | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { expiresAt?: unknown; value?: MonthlyClimate };
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now || !parsed.value) return null;
    const validTemperatures = [parsed.value.mean, parsed.value.max, parsed.value.min].every((value) => value === null || (typeof value === "number" && Number.isFinite(value)));
    if (!validTemperatures || !Number.isFinite(parsed.value.sampleCount)) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

export function writeClimateCache(storage: Pick<Storage, "setItem">, key: string, value: MonthlyClimate, now = Date.now()): void {
  try {
    storage.setItem(key, JSON.stringify({ expiresAt: now + CLIMATE_TTL_MS, value }));
  } catch {
    // Storage can be disabled or full; climate results remain usable for this search.
  }
}

export async function fetchMonthlyClimateBatch(airports: Airport[], month: number, signal?: AbortSignal): Promise<Map<string, MonthlyClimate>> {
  if (!airports.length) return new Map();
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
  const payload = await response.json() as { daily?: DailyData } | Array<{ daily?: DailyData }>;
  const items = Array.isArray(payload) ? payload : [payload];
  if (items.length !== airports.length) throw new Error("A klíma API eltérő számú reptéradatot adott vissza.");
  const results = new Map<string, MonthlyClimate>();
  for (const [index, item] of items.entries()) {
    const climate = item.daily ? calculateMonthlyClimate(item.daily, month) : null;
    if (climate) results.set(airports[index]!.iata, climate);
  }
  return results;
}

export async function mapWithLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  async function processNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) return;
    try {
      results[index] = { status: "fulfilled", value: await task(items[index]!) };
    } catch (reason) {
      results[index] = { status: "rejected", reason };
    }
    return processNext();
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => processNext()));
  return results;
}
const MAX_MINUTES = 720;
const VALID_AIRLINE_GROUPS = new Set(["ryanair", "wizz", "other"]);
export function defaultSearch(now = new Date()) {
    const monthIndex = now.getMonth() + 1;
    const month = monthIndex === 12 ? 1 : monthIndex + 1;
    return {
        from: "BUD",
        month,
        year: monthIndex === 12 ? now.getFullYear() + 1 : now.getFullYear(),
        minTemp: 18,
        maxTemp: 24,
        temperatureMode: "range",
        metric: "mean",
        maxFlightMinutes: 240,
        airlines: ["ryanair", "wizz"]
    };
}
function finiteNumber(value, min, max) {
    if (value === null || value.trim() === "")
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}
export function parseSearchParams(params, now = new Date()) {
    const fallback = defaultSearch(now);
    const month = finiteNumber(params.get("month"), 1, 12);
    const year = finiteNumber(params.get("year"), now.getFullYear(), now.getFullYear() + 2);
    const temperatureMode = params.get("temperatureMode");
    const metric = params.get("metric");
    const rawAirlines = params.get("airlines");
    const airlines = (rawAirlines ?? "").split(",").filter((group) => VALID_AIRLINE_GROUPS.has(group));
    const rawMaxMinutes = params.get("maxFlightMinutes");
    let maxMinutes = fallback.maxFlightMinutes;
    if (rawMaxMinutes === "")
        maxMinutes = undefined;
    else if (rawMaxMinutes !== null)
        maxMinutes = finiteNumber(rawMaxMinutes, 1, MAX_MINUTES) ?? fallback.maxFlightMinutes;
    const minTemp = finiteNumber(params.get("minTemp"), -40, 55);
    const maxTemp = finiteNumber(params.get("maxTemp"), -40, 55);
    return {
        from: /^[A-Z]{3}$/.test(params.get("from") ?? "") ? params.get("from") : fallback.from,
        month: month ?? fallback.month,
        year: year ?? (month !== undefined && month < fallback.month ? now.getFullYear() + 1 : now.getFullYear()),
        minTemp,
        maxTemp,
        temperatureMode: temperatureMode === "min" || temperatureMode === "max" || temperatureMode === "range" ? temperatureMode : fallback.temperatureMode,
        metric: metric === "max" || metric === "min" || metric === "mean" ? metric : fallback.metric,
        maxFlightMinutes: maxMinutes,
        airlines: rawAirlines === null ? fallback.airlines : [...new Set(airlines)]
    };
}
export function serializeSearch(state) {
    const params = new URLSearchParams();
    params.set("from", state.from);
    params.set("year", String(state.year));
    params.set("month", String(state.month));
    if (state.minTemp !== undefined)
        params.set("minTemp", String(state.minTemp));
    if (state.maxTemp !== undefined)
        params.set("maxTemp", String(state.maxTemp));
    params.set("maxFlightMinutes", state.maxFlightMinutes === undefined ? "" : String(state.maxFlightMinutes));
    params.set("airlines", state.airlines.join(","));
    params.set("metric", state.metric);
    params.set("temperatureMode", state.temperatureMode);
    return params.toString();
}
export function temperatureMatches(value, state) {
    if (state.temperatureMode === "min")
        return state.minTemp === undefined || value >= state.minTemp;
    if (state.temperatureMode === "max")
        return state.maxTemp === undefined || value <= state.maxTemp;
    return (state.minTemp === undefined || value >= state.minTemp) && (state.maxTemp === undefined || value <= state.maxTemp);
}
export function durationMatches(minutes, maximum) {
    return maximum === undefined || (minutes !== undefined && minutes <= maximum);
}
export function isValidSearch(state, currentYear = new Date().getFullYear()) {
    return state.month >= 1 && state.month <= 12
        && state.year >= currentYear && state.year <= currentYear + 2
        && (state.maxFlightMinutes === undefined || (state.maxFlightMinutes > 0 && state.maxFlightMinutes <= MAX_MINUTES))
        && !(state.minTemp !== undefined && state.maxTemp !== undefined && state.minTemp > state.maxTemp);
}

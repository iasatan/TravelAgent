import { AIRPORTS, AIRPORT_BY_IATA } from "./airports.js";
import { climateCacheKey, fetchMonthlyClimateBatch, mapWithLimit, readClimateCache, writeClimateCache, CLIMATE_START_YEAR, CLIMATE_END_YEAR } from "./climate.js";
import { getDestinations } from "./api.js";
import { deduplicateRoutes, filterRoutesByAirlineGroups, routeDuration } from "./flights.js";
import { formatDuration, monthName, renderResults } from "./render.js";
import { durationMatches, isValidSearch, parseSearchParams, serializeSearch, temperatureMatches } from "./state.js";
const form = requiredElement("search-form");
const resultGrid = requiredElement("results");
const summary = requiredElement("result-summary");
const statusMessage = requiredElement("status-message");
const sortOrder = requiredElement("sort-order");
const submitButton = form.querySelector('button[type="submit"]');
let state = parseSearchParams(new URLSearchParams(location.search));
let currentResults = [];
let activeController;
initializeForm();
applyStateToForm(state);
setTemperatureInputs();
form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = readFormState();
    if (!isValidSearch(next)) {
        showStatus("Ellenőrizd a megadott hőmérsékletet és repülési időt.", "error");
        return;
    }
    state = next;
    history.replaceState(null, "", `${location.pathname}?${serializeSearch(state)}`);
    void search(false);
});
requiredElement("refresh-button").addEventListener("click", () => {
    state = readFormState();
    history.replaceState(null, "", `${location.pathname}?${serializeSearch(state)}`);
    void search(true);
});
requiredElement("temperature-mode").addEventListener("change", setTemperatureInputs);
sortOrder.addEventListener("change", () => renderResults(resultGrid, currentResults, state, sortOrder.value));
if (location.search)
    await search(false);
function requiredElement(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Hiányzó HTML elem: ${id}`);
    return element;
}
function initializeForm() {
    const origin = requiredElement("origin");
    for (const airport of AIRPORTS) {
        const option = document.createElement("option");
        option.value = airport.iata;
        option.textContent = `${airport.iata} - ${airport.city}`;
        origin.append(option);
    }
    const month = requiredElement("month");
    const now = new Date();
    const nextMonth = now.getMonth() + 1 === 12 ? 1 : now.getMonth() + 2;
    for (let value = 1; value <= 12; value += 1) {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = `${monthName(value)}${value === nextMonth ? " (következő hónap)" : ""}`;
        month.append(option);
    }
    const duration = requiredElement("max-duration");
    for (let minutes = 60; minutes <= 720; minutes += 30) {
        const option = document.createElement("option");
        option.value = String(minutes);
        option.textContent = formatDuration(minutes);
        duration.append(option);
    }
}
function applyStateToForm(search) {
    requiredElement("origin").value = search.from;
    requiredElement("month").value = String(search.month);
    requiredElement("temperature-mode").value = search.temperatureMode;
    requiredElement("min-temp").value = search.minTemp === undefined ? "" : String(search.minTemp);
    requiredElement("max-temp").value = search.maxTemp === undefined ? "" : String(search.maxTemp);
    requiredElement("metric").value = search.metric;
    requiredElement("max-duration").value = search.maxFlightMinutes === undefined ? "" : String(search.maxFlightMinutes);
    for (const checkbox of form.querySelectorAll('input[name="airlines"]'))
        checkbox.checked = search.airlines.includes(checkbox.value);
}
function readFormState() {
    const formData = new FormData(form);
    const originValue = formData.get("from");
    const metricValue = formData.get("metric");
    const month = Number(formData.get("month"));
    const now = new Date();
    const year = month < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
    const mode = formData.get("temperatureMode");
    const readTemp = (id) => {
        const value = requiredElement(id).value;
        return value === "" ? undefined : Number(value);
    };
    return {
        from: typeof originValue === "string" ? originValue : "",
        month, year,
        minTemp: mode === "max" ? undefined : readTemp("min-temp"),
        maxTemp: mode === "min" ? undefined : readTemp("max-temp"),
        temperatureMode: mode,
        metric: metricValue === "max" ? "max" : "mean",
        maxFlightMinutes: formData.get("maxFlightMinutes") ? Number(formData.get("maxFlightMinutes")) : undefined,
        airlines: formData.getAll("airlines").map(String)
    };
}
function setTemperatureInputs() {
    const mode = requiredElement("temperature-mode").value;
    const minimum = requiredElement("min-temp");
    const maximum = requiredElement("max-temp");
    minimum.disabled = mode === "max";
    maximum.disabled = mode === "min";
    requiredElement("minimum-wrap").hidden = mode === "max";
    requiredElement("maximum-wrap").hidden = mode === "min";
}
async function search(refresh) {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    submitButton.disabled = true;
    resultGrid.replaceChildren();
    showStatus(navigator.onLine ? "Közvetlen útvonalak és történelmi klímaadatok lekérése…" : "Offline állapot. Ellenőrizd az internetkapcsolatot.", navigator.onLine ? "loading" : "error");
    summary.textContent = "Keresés folyamatban…";
    try {
        const flightData = await getDestinations(state, controller.signal, refresh);
        const candidates = getFlightCandidates(state, flightData);
        const climateResults = await loadCandidateClimates(candidates, state, refresh, controller.signal);
        if (controller.signal.aborted)
            return;
        const climateSummary = collectClimateResults(climateResults, state);
        currentResults = climateSummary.results;
        renderResults(resultGrid, currentResults, state, sortOrder.value);
        summary.textContent = `${currentResults.length} úti cél · ${monthName(state.month)} ${state.year}`;
        showClimateStatus(climateSummary.failedCount, climateSummary.rateLimited, flightData.providerErrors);
    }
    catch (error) {
        if (controller.signal.aborted)
            return;
        currentResults = [];
        summary.textContent = "A keresés nem sikerült.";
        showStatus(error instanceof Error ? error.message : "Ismeretlen hiba történt.", "error");
    }
    finally {
        if (activeController === controller)
            submitButton.disabled = false;
    }
}
function getFlightCandidates(searchState, flightData) {
    const airportByIata = new Map(AIRPORT_BY_IATA);
    for (const airport of flightData.airports)
        airportByIata.set(airport.iata, airport);
    const grouped = deduplicateRoutes(filterRoutesByAirlineGroups(flightData.routes, searchState.airlines));
    const origin = airportByIata.get(searchState.from);
    if (!origin)
        throw new Error("Az indulási repülőtér nincs az adatbázisban.");
    const candidates = [];
    for (const [iata, groupedRoutes] of grouped) {
        const airport = airportByIata.get(iata);
        if (!airport)
            continue;
        const duration = routeDuration(groupedRoutes, origin, airport);
        if (!durationMatches(duration.minutes, searchState.maxFlightMinutes))
            continue;
        candidates.push({ airport, routes: groupedRoutes, ...duration });
    }
    return candidates;
}
async function loadCandidateClimates(candidates, searchState, refresh, signal) {
    const storage = safeStorage();
    const results = new Array(candidates.length);
    const missing = findMissingClimate(candidates, searchState, refresh, storage, results);
    const batches = chunkClimateCandidates(missing, 20);
    const climateBatches = await mapWithLimit(batches, 2, async (batch) => fetchMonthlyClimateBatch(batch.map(({ candidate }) => candidate.airport), searchState.month, signal));
    for (const [batchIndex, outcome] of climateBatches.entries()) {
        applyClimateBatch(batches[batchIndex], outcome, results, storage, searchState.month);
    }
    return results;
}
function findMissingClimate(candidates, searchState, refresh, storage, results) {
    const missing = [];
    for (const [index, candidate] of candidates.entries()) {
        const key = climateCacheKey(candidate.airport.iata, searchState.month);
        const cached = refresh ? null : readClimateCache(storage, key);
        if (cached)
            results[index] = { status: "fulfilled", value: { candidate, climate: cached } };
        else
            missing.push({ index, candidate });
    }
    return missing;
}
function chunkClimateCandidates(items, size) {
    const batches = [];
    for (let index = 0; index < items.length; index += size)
        batches.push(items.slice(index, index + size));
    return batches;
}
function applyClimateBatch(batch, outcome, results, storage, month) {
    for (const item of batch) {
        if (outcome.status === "rejected") {
            results[item.index] = { status: "rejected", reason: outcome.reason };
            continue;
        }
        const climate = outcome.value.get(item.candidate.airport.iata);
        if (!climate) {
            results[item.index] = { status: "rejected", reason: new Error("Ehhez a reptérhez nem érhető el klímaadat.") };
            continue;
        }
        writeClimateCache(storage, climateCacheKey(item.candidate.airport.iata, month), climate);
        results[item.index] = { status: "fulfilled", value: { candidate: item.candidate, climate } };
    }
}
function collectClimateResults(outcomes, searchState) {
    const results = [];
    let failedCount = 0;
    let rateLimited = false;
    for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
            failedCount += 1;
            rateLimited ||= isRateLimitError(outcome.reason);
            continue;
        }
        const { candidate, climate } = outcome.value;
        const temperature = climate[searchState.metric];
        if (temperature === null || !temperatureMatches(temperature, searchState))
            continue;
        results.push({
            airport: candidate.airport,
            airlines: [...new Set(candidate.routes.map((route) => route.airlineIata))].sort((a, b) => a.localeCompare(b)),
            durationMinutes: candidate.minutes,
            durationType: candidate.type,
            scheduleVerified: candidate.scheduleVerified,
            climate
        });
    }
    return { results, failedCount, rateLimited };
}
function isRateLimitError(error) {
    return typeof error === "object" && error !== null && "status" in error && error.status === 429;
}
function showClimateStatus(failedCount, rateLimited, providerErrors) {
    const messages = [...providerErrors];
    if (failedCount) {
        const rateLimitMessage = rateLimited ? " A klímaforrás lekérési korlátja miatt várj, majd frissíts." : "";
        messages.push(`${failedCount} repülőtér klímaadata nem volt elérhető; a többi találat megjelenik.${rateLimitMessage}`);
    }
    messages.push(`Többéves történelmi klímaátlag: ${CLIMATE_START_YEAR}–${CLIMATE_END_YEAR}.`);
    showStatus(messages.join(" "), providerErrors.length || failedCount ? "warning" : "info");
}
function showStatus(message, kind) {
    statusMessage.textContent = message;
    statusMessage.dataset.kind = kind;
}
function safeStorage() {
    try {
        return localStorage;
    }
    catch {
        return { getItem: () => null, setItem: () => undefined };
    }
}

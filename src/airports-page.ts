import { getDestinations } from "./api.js";
import { getAirportNetwork, type AirportNetworkData, type AirportNetworkRoute } from "./network.js";
import { fetchPowerMonthlyClimateBatch, powerClimateCacheKey, POWER_CLIMATE_END_YEAR, POWER_CLIMATE_START_YEAR, readPowerClimateCache, writePowerClimateCache } from "./power-climate.js";
import { monthName } from "./render.js";
import { defaultSearch } from "./state.js";
import type { Airport, MonthlyClimate, SearchState } from "./types.js";

type SortKey = "airport" | "country" | "routeAirlines" | "schedule" | "weather";
type SortDirection = "ascending" | "descending";

const originSelect = requiredElement<HTMLSelectElement>("airport-origin");
const monthSelect = requiredElement<HTMLSelectElement>("airport-month");
const filterInput = requiredElement<HTMLInputElement>("airport-filter");
const rowsElement = requiredElement<HTMLTableSectionElement>("airport-rows");
const summary = requiredElement<HTMLParagraphElement>("airport-summary");
const statusMessage = requiredElement<HTMLOutputElement>("airport-status");
const airportApi = document.querySelector<HTMLMetaElement>('meta[name="travel-agent-api"]')?.content.trim();
const storage = safeStorage();
let network: AirportNetworkData;
let routeEntries: Array<{ airport: Airport; route: AirportNetworkRoute }> = [];
let climateByAirport = new Map<string, MonthlyClimate>();
let scheduledAirlines = new Map<string, string[]>();
let climateController: AbortController | undefined;
let airlineController: AbortController | undefined;
let sortKey: SortKey = "airport";
let sortDirection: SortDirection = "ascending";

initializeMonths();
updateSortHeaders();
requiredElement<HTMLTableSectionElement>("airport-table-head").addEventListener("click", handleSortClick);
filterInput.addEventListener("input", renderRows);
originSelect.addEventListener("change", () => updateRoutes());
monthSelect.addEventListener("change", () => updateRoutes());
requiredElement<HTMLButtonElement>("network-refresh").addEventListener("click", () => { void loadNetwork(true); });
requiredElement<HTMLButtonElement>("airline-refresh").addEventListener("click", () => { void loadAirlines(); });

await loadNetwork(false);

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Hiányzó HTML elem: ${id}`);
  return element as T;
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> {
  try { return localStorage; }
  catch { return { getItem: () => null, setItem: () => undefined }; }
}

function initializeMonths(): void {
  const currentMonth = new Date().getMonth() + 1;
  for (let month = 1; month <= 12; month += 1) {
    const option = document.createElement("option");
    option.value = String(month);
    option.textContent = monthName(month);
    monthSelect.append(option);
  }
  const requestedMonth = Number(new URLSearchParams(location.search).get("month"));
  monthSelect.value = String(Number.isInteger(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12 ? requestedMonth : currentMonth);
}

async function loadNetwork(refresh: boolean): Promise<void> {
  climateController?.abort();
  airlineController?.abort();
  if (!airportApi) {
    showStatus("A repülési API még nincs konfigurálva.", "error");
    return;
  }
  showStatus(refresh ? "Az útvonalhálózat frissítése folyamatban…" : "A repülőtér-hálózat betöltése…", "loading");
  try {
    network = await getAirportNetwork(airportApi, storage, undefined, refresh);
    populateOrigins();
    updateRoutes(refresh);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : "A repülőtér-adatok betöltése nem sikerült.", "error");
    summary.textContent = "A repülőtér-hálózat nem érhető el.";
  }
}

function populateOrigins(): void {
  const airports = [...network.airports].sort((a, b) => a.city.localeCompare(b.city) || a.iata.localeCompare(b.iata));
  const selected = new URLSearchParams(location.search).get("from") || (airports.some((airport) => airport.iata === "BUD") ? "BUD" : airports[0]?.iata ?? "");
  originSelect.replaceChildren();
  for (const airport of airports) {
    const option = document.createElement("option");
    option.value = airport.iata;
    option.textContent = `${airport.iata} · ${airport.city} (${airport.country})`;
    originSelect.append(option);
  }
  originSelect.value = airports.some((airport) => airport.iata === selected) ? selected : airports[0]?.iata ?? "";
}

function updateRoutes(refreshClimate = false): void {
  climateController?.abort();
  airlineController?.abort();
  scheduledAirlines.clear();
  climateByAirport.clear();
  const origin = originSelect.value;
  const airports = new Map(network.airports.map((airport) => [airport.iata, airport]));
  const destinations = new Map<string, { airport: Airport; route: AirportNetworkRoute }>();
  for (const route of network.routes) {
    if (route.from !== origin || !airports.has(route.to)) continue;
    const previous = destinations.get(route.to);
    if (previous) previous.route.airlines = [...new Set([...previous.route.airlines, ...route.airlines])];
    else destinations.set(route.to, { airport: airports.get(route.to)!, route: { ...route, airlines: [...route.airlines] } });
  }
  routeEntries = [...destinations.values()].sort((a, b) => a.airport.city.localeCompare(b.airport.city));
  const params = new URLSearchParams({ from: origin, month: monthSelect.value });
  history.replaceState(null, "", `${location.pathname}?${params}`);
  renderRows();
  if (!routeEntries.length) {
    summary.textContent = "Nincs közvetlen útvonal ehhez az indulási repülőtérhez.";
    showStatus("Válassz másik indulási repülőteret.", "info");
    return;
  }
  summary.textContent = `${routeEntries.length} közvetlen úti cél · ${origin}`;
  void loadClimateThenAirlines(refreshClimate);
}

async function loadClimateThenAirlines(refreshClimate: boolean): Promise<void> {
  const controller = new AbortController();
  climateController = controller;
  await loadClimates(controller.signal, refreshClimate);
  if (!controller.signal.aborted) void loadAirlines();
}

async function loadClimates(signal: AbortSignal, refresh: boolean): Promise<void> {
  const month = Number(monthSelect.value);
  const missing: Airport[] = [];
  for (const { airport } of routeEntries) {
    const key = powerClimateCacheKey(airport.iata, month);
    const cached = refresh ? null : readPowerClimateCache(storage, key);
    if (cached) climateByAirport.set(airport.iata, cached);
    else missing.push(airport);
  }
  renderRows();
  if (!missing.length) {
    showStatus(`${monthName(month)} havi klímaadatok a helyi gyorsítótárból · ${POWER_CLIMATE_START_YEAR}–${POWER_CLIMATE_END_YEAR}.`, "info");
    return;
  }
  showStatus(`${monthName(month)} havi klímaadatainak lekérése ${missing.length} úti célhoz…`, "loading");
  const result = await loadClimateBatch(missing, month, signal);
  if (signal.aborted) return;
  if (result.rateLimited) {
    showStatus("A klímaforrás átmeneti lekérési korlátot jelzett. A már betöltött adatok mentve vannak; próbáld meg később újra.", "warning");
    return;
  }
  const missingCount = routeEntries.filter(({ airport }) => !climateByAirport.has(airport.iata)).length;
  showStatus(missingCount ? `${missingCount} repülőtér havi klímaadata nem volt elérhető.` : `${monthName(month)} klímaadatai mentve a helyi gyorsítótárba · ${POWER_CLIMATE_START_YEAR}–${POWER_CLIMATE_END_YEAR}.`, missingCount ? "warning" : "info");
}

async function loadClimateBatch(airports: Airport[], month: number, signal: AbortSignal): Promise<{ rateLimited: boolean }> {
  const result = await fetchPowerMonthlyClimateBatch(airports, month, signal);
  for (const [iata, climate] of result.climates) {
    climateByAirport.set(iata, climate);
    writePowerClimateCache(storage, powerClimateCacheKey(iata, month), climate);
  }
  renderRows();
  return { rateLimited: result.rateLimited };
}

async function loadAirlines(): Promise<void> {
  airlineController?.abort();
  const controller = new AbortController();
  airlineController = controller;
  if (!airportApi || !originSelect.value || !routeEntries.length) return;
  showStatus("A havi légitársasági menetrend lekérése…", "loading");
  const month = Number(monthSelect.value);
  const now = new Date();
  const search: SearchState = {
    ...defaultSearch(now),
    from: originSelect.value,
    month,
    year: month < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear(),
    airlines: ["ryanair", "wizz"]
  };
  try {
    const data = await getDestinations(search, controller.signal);
    if (controller.signal.aborted) return;
    mergeScheduledAirlines(data.routes.map((route) => ({ arrivalIata: route.arrivalIata, airlineIata: route.airlineIata })));
    renderRows();
    const count = scheduledAirlines.size;
    const providerErrors = data.providerErrors.length ? ` ${data.providerErrors.join(" ")}` : "";
    showStatus(`${count} úti célhoz érhető el havi légitársasági menetrend.${providerErrors}`, data.providerErrors.length ? "warning" : "info");
  } catch (error) {
    if (controller.signal.aborted) return;
    renderRows();
    showStatus(error instanceof Error ? error.message : "A légitársasági adatok nem érhetők el.", "warning");
  }
}

function mergeScheduledAirlines(routes: Array<{ arrivalIata: string; airlineIata: string }>): void {
  const destinations = new Set(routeEntries.map((entry) => entry.airport.iata));
  for (const route of routes) {
    if (!destinations.has(route.arrivalIata)) continue;
    const names = airlineName(route.airlineIata);
    scheduledAirlines.set(route.arrivalIata, [...new Set([...(scheduledAirlines.get(route.arrivalIata) ?? []), names])]);
  }
}

function airlineName(code: string): string {
  if (code === "FR") return "Ryanair";
  if (["W6", "W9", "W4", "5W"].includes(code)) return "Wizz Air";
  return code;
}

function renderRows(): void {
  const query = filterInput.value.trim().toLocaleLowerCase();
  const visible = routeEntries
    .filter(({ airport }) => `${airport.iata} ${airport.city} ${airport.name} ${airport.country}`.toLocaleLowerCase().includes(query))
    .sort(compareRouteEntries);
  rowsElement.replaceChildren();
  for (const { airport, route } of visible) {
    const row = document.createElement("tr");
    appendCell(row, `${airport.city} · ${airport.iata}`, airport.name);
    appendCell(row, airport.country);
    appendCell(row, route.airlines.length ? route.airlines.join(", ") : "Nincs forrásadat", "AirportMiles útvonaladat");
    appendCell(row, scheduledAirlines.get(airport.iata)?.join(", ") ?? "Nincs lekérve");
    const climate = climateByAirport.get(airport.iata);
    const mean = climate?.mean;
    const detail = climate ? `Átlagos minimum ${formatTemperature(climate.min)} · maximum ${formatTemperature(climate.max)} · ${monthName(Number(monthSelect.value))} (${POWER_CLIMATE_START_YEAR}–${POWER_CLIMATE_END_YEAR})` : `${monthName(Number(monthSelect.value))} havi átlag`;
    appendCell(row, mean === null || mean === undefined ? "Betöltés…" : `${mean.toFixed(1)} °C`, detail);
    rowsElement.append(row);
  }
  if (!visible.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-state-cell";
    cell.textContent = "Nincs a keresésnek megfelelő úti cél.";
    row.append(cell);
    rowsElement.append(row);
  }
}

function appendCell(row: HTMLTableRowElement, text: string, detail?: string): void {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    cell.append(small);
  }
  row.append(cell);
}

function showStatus(message: string, kind: string): void {
  statusMessage.textContent = message;
  statusMessage.dataset.kind = kind;
}

function formatTemperature(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} °C`;
}

function handleSortClick(event: Event): void {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button[data-sort]");
  const nextKey = button?.dataset.sort as SortKey | undefined;
  if (!nextKey) return;
  if (sortKey === nextKey) sortDirection = sortDirection === "ascending" ? "descending" : "ascending";
  else {
    sortKey = nextKey;
    sortDirection = "ascending";
  }
  updateSortHeaders();
  renderRows();
}

function updateSortHeaders(): void {
  document.querySelectorAll<HTMLTableCellElement>(".airport-table thead th").forEach(updateSortHeader);
}

function updateSortHeader(header: HTMLTableCellElement): void {
  const button = header.querySelector<HTMLButtonElement>("button[data-sort]");
  if (!button) return;
  const active = button.dataset.sort === sortKey;
  header.setAttribute("aria-sort", active ? sortDirection : "none");
  const indicator = button.querySelector("span");
  if (indicator) indicator.textContent = sortIndicator(active);
  const direction = active && sortDirection === "descending" ? "csökkenő" : "növekvő";
  button.setAttribute("aria-label", `${button.textContent?.trim().replace(/[↑↓]/g, "")}, rendezés ${direction} sorrendben`);
}

function sortIndicator(active: boolean): string {
  if (!active) return "";
  return sortDirection === "ascending" ? "↑" : "↓";
}

function sortValue(entry: (typeof routeEntries)[number]): string | number | null {
  switch (sortKey) {
    case "airport": return `${entry.airport.city} ${entry.airport.iata}`;
    case "country": return entry.airport.country;
    case "routeAirlines": return entry.route.airlines.join(", ");
    case "schedule": return scheduledAirlines.get(entry.airport.iata)?.join(", ") ?? "";
    case "weather": return climateByAirport.get(entry.airport.iata)?.mean ?? null;
  }
}

function compareRouteEntries(left: (typeof routeEntries)[number], right: (typeof routeEntries)[number]): number {
  const leftValue = sortValue(left);
  const rightValue = sortValue(right);
  const leftMissing = leftValue === null || leftValue === "";
  const rightMissing = rightValue === null || rightValue === "";
  if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
  let comparison = typeof leftValue === "number" && typeof rightValue === "number"
    ? leftValue - rightValue
    : String(leftValue ?? "").localeCompare(String(rightValue ?? ""), "hu", { sensitivity: "base", numeric: true });
  if (!comparison) comparison = left.airport.iata.localeCompare(right.airport.iata);
  return sortDirection === "ascending" ? comparison : -comparison;
}
import type { DestinationResult, SearchState } from "./types.js";

const MONTH_FORMATTER = new Intl.DateTimeFormat("hu-HU", { month: "long" });
const NUMBER_FORMATTER = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 1 });

export function monthName(month: number): string {
  return MONTH_FORMATTER.format(new Date(2026, month - 1, 1));
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (!hours) return `${remaining} perc`;
  return remaining ? `${hours} óra ${remaining} perc` : `${hours} óra`;
}

export function sortResults(results: DestinationResult[], sort: string, metric: SearchState["metric"]): DestinationResult[] {
  const value = (result: DestinationResult) => result.climate[metric];
  return [...results].sort((a, b) => {
    if (sort === "temperature-desc") return value(b) - value(a);
    if (sort === "duration") return a.durationMinutes - b.durationMinutes || a.airport.city.localeCompare(b.airport.city, "hu");
    if (sort === "city") return a.airport.city.localeCompare(b.airport.city, "hu");
    if (sort === "country") return a.airport.country.localeCompare(b.airport.country, "hu") || a.airport.city.localeCompare(b.airport.city, "hu");
    return value(a) - value(b);
  });
}

export function renderResults(container: HTMLElement, results: DestinationResult[], state: SearchState, sort: string): void {
  container.replaceChildren();
  const sorted = sortResults(results, sort, state.metric);
  if (!sorted.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Nem találtunk olyan közvetlen úti célt, amely megfelel minden feltételnek. Próbáld növelni a maximális repülési időt, szélesíteni a hőmérsékleti tartományt vagy több légitársaságot választani.";
    container.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const result of sorted) {
    const card = document.createElement("article");
    card.className = "destination-card";
    const heading = document.createElement("h3");
    heading.textContent = result.airport.city;
    const country = document.createElement("p");
    country.className = "destination-country";
    country.textContent = result.airport.country;
    const airport = document.createElement("p");
    airport.className = "airport-line";
    airport.textContent = `${result.airport.iata} · ${result.airport.name}`;
    const metrics = document.createElement("div");
    metrics.className = "metrics";
    metrics.append(
      metricBlock(`${NUMBER_FORMATTER.format(result.climate[state.metric])} °C`, state.metric === "mean" ? `átlagos ${monthName(state.month)}i középhőmérséklet` : `átlagos ${monthName(state.month)}i nappali maximum`),
      metricBlock(formatDuration(result.durationMinutes), result.durationType === "scheduled" ? "menetrend szerinti repülési idő" : "becsült repülési idő")
    );
    const meta = document.createElement("div");
    meta.className = "card-meta";
    for (const airline of result.airlines) meta.append(badge(airlineLabel(airline)));
    meta.append(badge(result.scheduleVerified ? "Menetrend alapján ellenőrizve" : "Általános útvonaladat"));
    if (result.durationType === "estimated") meta.append(badge("Repülési idő becslés", true));
    card.append(heading, country, airport, metrics, meta);
    fragment.append(card);
  }
  container.append(fragment);
}

function metricBlock(value: string, label: string): HTMLElement {
  const block = document.createElement("div");
  const strong = document.createElement("span");
  strong.className = "metric-value";
  strong.textContent = value;
  const caption = document.createElement("span");
  caption.className = "metric-label";
  caption.textContent = label;
  block.append(strong, caption);
  return block;
}

function badge(text: string, estimate = false): HTMLElement {
  const element = document.createElement("span");
  element.className = estimate ? "badge badge--estimate" : "badge";
  element.textContent = text;
  return element;
}

function airlineLabel(code: string): string {
  if (code === "FR") return "Ryanair";
  if (["W6", "W9", "W4", "5W"].includes(code)) return "Wizz Air";
  return code;
}
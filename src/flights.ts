import type { Airport, DurationType, FlightRoute } from "./types.js";
import { AIRLINE_GROUPS } from "./airports.js";

const EARTH_RADIUS_KM = 6371;
const CRUISE_SPEED_KMH = 800;
const TAKEOFF_LANDING_OVERHEAD_MINUTES = 30;

export function haversineDistanceKm(from: Pick<Airport, "latitude" | "longitude">, to: Pick<Airport, "latitude" | "longitude">): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function estimatedDurationMinutes(distanceKm: number): number {
  return Math.round(distanceKm / CRUISE_SPEED_KMH * 60 + TAKEOFF_LANDING_OVERHEAD_MINUTES);
}

export function durationForRoute(route: FlightRoute, from: Airport, to: Airport): { minutes: number; type: DurationType } {
  if (route.durationType === "scheduled" && route.durationMinutes && route.durationMinutes > 0) {
    return { minutes: Math.round(route.durationMinutes), type: "scheduled" };
  }
  const hasTimezoneOffset = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  if (route.scheduledDeparture && route.scheduledArrival
    && hasTimezoneOffset(route.scheduledDeparture) && hasTimezoneOffset(route.scheduledArrival)) {
    const departure = Date.parse(route.scheduledDeparture);
    const arrival = Date.parse(route.scheduledArrival);
    const minutes = (arrival - departure) / 60_000;
    if (Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60) return { minutes: Math.round(minutes), type: "scheduled" };
  }
  if (route.durationType === "estimated" && route.durationMinutes && route.durationMinutes > 0) {
    return { minutes: Math.round(route.durationMinutes), type: "estimated" };
  }
  return { minutes: estimatedDurationMinutes(haversineDistanceKm(from, to)), type: "estimated" };
}

export function filterRoutesByAirline(routes: FlightRoute[], selectedCodes?: string[]): FlightRoute[] {
  if (!selectedCodes) return routes;
  const allowed = new Set(selectedCodes);
  return routes.filter((route) => allowed.has(route.airlineIata));
}

export function filterRoutesByAirlineGroups(routes: FlightRoute[], groups: string[]): FlightRoute[] {
  const selectedCodes = groups.flatMap((group) => AIRLINE_GROUPS[group] ?? []);
  if (!groups.includes("other")) return filterRoutesByAirline(routes, selectedCodes);
  const knownCodes = new Set(Object.values(AIRLINE_GROUPS).flat());
  if (selectedCodes.length === knownCodes.size) return routes;
  const selected = new Set(selectedCodes);
  return routes.filter((route) => selected.has(route.airlineIata) || !knownCodes.has(route.airlineIata));
}

export function deduplicateRoutes(routes: FlightRoute[]): Map<string, FlightRoute[]> {
  const byDestination = new Map<string, FlightRoute[]>();
  for (const route of routes) {
    if (route.departureIata === route.arrivalIata) continue;
    const existing = byDestination.get(route.arrivalIata) ?? [];
    if (!existing.some((item) => item.airlineIata === route.airlineIata && item.flightNumber === route.flightNumber)) existing.push(route);
    byDestination.set(route.arrivalIata, existing);
  }
  return byDestination;
}

export function routeDuration(routes: FlightRoute[], from: Airport, to: Airport): { minutes: number; type: DurationType; scheduleVerified: boolean } {
  const durations = routes.map((route) => ({
    ...durationForRoute(route, from, to),
    scheduleVerified: route.scheduleVerified
  })).sort((a, b) => a.minutes - b.minutes);
  const shortest = durations[0];
  return shortest ?? { minutes: estimatedDurationMinutes(haversineDistanceKm(from, to)), type: "estimated", scheduleVerified: false };
}

export function parseRoutesResponse(payload: unknown): FlightRoute[] {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { routes?: unknown }).routes)) {
    throw new Error("A járat API hibás választ adott.");
  }
  return (payload as { routes: unknown[] }).routes.flatMap((item): FlightRoute[] => {
    if (typeof item !== "object" || item === null) return [];
    const route = item as Record<string, unknown>;
    if (typeof route.departureIata !== "string" || !/^[A-Z]{3}$/.test(route.departureIata)
      || typeof route.arrivalIata !== "string" || !/^[A-Z]{3}$/.test(route.arrivalIata)
      || typeof route.airlineIata !== "string" || !/^[A-Z0-9]{2,3}$/.test(route.airlineIata)) return [];
    const duration = typeof route.durationMinutes === "number" && Number.isFinite(route.durationMinutes) && route.durationMinutes > 0 ? route.durationMinutes : undefined;
    const durationType = route.durationType === "scheduled" || route.durationType === "estimated" ? route.durationType : "unknown";
    return [{
      departureIata: route.departureIata,
      arrivalIata: route.arrivalIata,
      airlineIata: route.airlineIata,
      ...(typeof route.flightNumber === "string" ? { flightNumber: route.flightNumber } : {}),
      ...(typeof route.scheduledDeparture === "string" ? { scheduledDeparture: route.scheduledDeparture } : {}),
      ...(typeof route.scheduledArrival === "string" ? { scheduledArrival: route.scheduledArrival } : {}),
      ...(duration !== undefined ? { durationMinutes: duration } : {}),
      durationType,
      scheduleVerified: route.scheduleVerified === true
    }];
  });
}
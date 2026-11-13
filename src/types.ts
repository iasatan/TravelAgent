export interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export type DurationType = "scheduled" | "estimated" | "unknown";
export type TemperatureMetric = "mean" | "max";
export type TemperatureMode = "min" | "max" | "range";

export interface FlightRoute {
  departureIata: string;
  arrivalIata: string;
  airlineIata: string;
  flightNumber?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
  durationMinutes?: number;
  durationType: DurationType;
  scheduleVerified: boolean;
}

export interface FlightSearchData {
  routes: FlightRoute[];
  airports: Airport[];
  providerErrors: string[];
}

export interface SearchState {
  from: string;
  month: number;
  year: number;
  minTemp?: number;
  maxTemp?: number;
  temperatureMode: TemperatureMode;
  metric: TemperatureMetric;
  maxFlightMinutes?: number;
  airlines: string[];
}

export interface MonthlyClimate {
  mean: number;
  max: number;
  sampleCount: number;
}

export interface DestinationResult {
  airport: Airport;
  airlines: string[];
  durationMinutes: number;
  durationType: DurationType;
  scheduleVerified: boolean;
  climate: MonthlyClimate;
}
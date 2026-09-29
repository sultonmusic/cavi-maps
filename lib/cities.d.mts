export type City = {
  name: string;
  region: string;
  lat: number;
  lon: number;
  zoom: number;
  /** Half the town's box in degrees of latitude; null for the whole country. */
  r: number | null;
  aliases: readonly string[];
};
export const REGIONS: readonly string[];
export const CITIES: readonly City[];
export const COUNTRY: City;
export function cityByName(name: string): City | undefined;
export function nearestCity(lat: number, lon: number): { city: City; km: number } | null;
export function cityAt(lat: number, lon: number): City | null;
export function inCity(city: City, lat: number, lon: number): boolean;

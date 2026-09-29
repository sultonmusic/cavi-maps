import type { City } from './cities.mjs';

/** A square-ish box around lat, lon: r is half its side in degrees of latitude. */
export type OfflineArea = { id: string; name: string; lat: number; lon: number; r: number };
/** What exists: atlas-data tiles as 'z-x-y.json', house groups and zoom-10 files as 'x-y'. */
export type TileLists = {
  tiles: ReadonlySet<string>;
  houses: ReadonlySet<string>;
  roads: ReadonlySet<string>;
  things: ReadonlySet<string>;
  walks: ReadonlySet<string>;
};
export const TILE_TIERS: readonly number[];
export const VIEW_RADIUS: number;
export const MIN_CITY_RADIUS: number;
export function cityArea(city: City): OfflineArea;
export function viewArea(lon: number, lat: number): OfflineArea;
export function areaFiles(area: OfflineArea, lists: TileLists): string[];
export function isSavedMapPath(path: string): boolean;
export function sumBytes(urls: readonly string[], sizes: Readonly<Record<string, number>> | null): number | null;
export function formatBytes(n: number): string;

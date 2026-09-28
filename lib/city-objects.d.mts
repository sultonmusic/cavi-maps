export type CityKind = 'path' | 'square' | 'lawn' | 'fountain' | 'flag' | 'monument' | 'lamp' | 'bench' | 'tree' | 'bin';
export type Surface = 'plain' | 'tiles' | 'asphalt';
type Sizes = { width?: number; height?: number; length?: number; thickness?: number; rotation?: number; surface?: Surface };
export type ValidatedCityObject = { id: string; name: string; updatedAt: number } & Sizes & (
  | { kind: 'flag' | 'monument' | 'lamp' | 'bench' | 'tree' | 'bin'; geometry: { type: 'Point'; coordinates: number[] } }
  | { kind: 'path'; geometry: { type: 'LineString'; coordinates: number[][] } }
  | { kind: 'square' | 'lawn'; geometry: { type: 'LineString'; coordinates: number[][] } | { type: 'Polygon'; coordinates: number[][][] } }
  | { kind: 'fountain'; geometry: { type: 'Polygon'; coordinates: number[][][] } });
export function isNarrowOutline(ring: number[][]): boolean;
export const CITY_KINDS: readonly CityKind[];
export const SURFACES: readonly Surface[];
export type SizeKey = 'width' | 'height' | 'length' | 'thickness' | 'rotation';
/** Per kind: [lowest, highest, default?] for each size it may carry. */
export const CITY_SIZES: Readonly<Partial<Record<CityKind, Partial<Record<SizeKey, readonly [number, number, number?]>>>>>;
export function validateCityObject(input: unknown): ValidatedCityObject;
export function encodeCloudCityObject(input: unknown): Record<string, unknown>;
export function decodeCloudCityObject(input: unknown): ValidatedCityObject;

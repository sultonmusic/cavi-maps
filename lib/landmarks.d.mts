export type Colour = [number, number, number];
export type LandmarkPlace = { id: string; lat: number; lon: number; tags: Record<string, string> };
export type Landmark = {
  id: string; key: string; centre: [number, number]; axis: number
  half: [number, number]; radius: number; clear: number; top: number; extent: number; minzoom: number
  build: (night: boolean) => Float32Array
  place: LandmarkPlace
};
export const MAX_LANDMARK_VERTICES: number;
export const LANDMARKS: readonly Landmark[];
export const STADIUM: Readonly<Record<string, unknown>>;
export const STADIUM_COLOURS: Readonly<Record<string, Colour>>;
export function mercX(lon: number): number;
export function mercY(lat: number): number;
export function roundedRing(a: number, b: number, r: number, counts: readonly [number, number, number]): [number, number, number, number][];
export function insideRounded(x: number, y: number, a: number, b: number, r: number): boolean;
/** A height along a ring: one number, or one per ring point. */
export type RingHeight = number | ((i: number) => number);
export function meshWriter(axis: number, vertices?: number): {
  face(points: readonly (readonly number[])[], colour: readonly number[], hint: readonly number[], emissive?: boolean): void
  strip(inner: readonly (readonly number[])[], zi: RingHeight, outer: readonly (readonly number[])[], zo: RingHeight, paint: (i: number) => readonly [readonly number[], boolean?] | null, hint: 'up' | 'down' | 'in' | 'out'): void
  box(x: number, y: number, hx: number, hy: number, bottom: number, top: number, colours: readonly (readonly number[])[], turn?: number, emissive?: readonly boolean[], lid?: boolean): void
  done(): Float32Array
};
/** The stadium's ring at distance d outward from the edge of its sports area (d = STADIUM.D is the facade). */
export function stadiumRing(d: number): [number, number, number, number][];
/** The trees in the apron's verge: model metres [x across, y along, ring segment]. */
export function stadiumTreeSpots(): [number, number, number][];
export function stadiumTriangles(axis: number, night?: boolean): Float32Array;
export function modelOf(landmark: Landmark, mx: number, my: number): [number, number];
export function landmarkAt(lon: number, lat: number): Landmark | null;
export function landmarkCovers(ring: readonly (readonly number[])[]): boolean;
export function landmarkTileFilter(z: number, x: number, y: number): ((ring: number[][]) => boolean) | null;
export function landmarkPlaces(): LandmarkPlace[];
export function landmarkPlace(id: string): LandmarkPlace | null;
export function landmarkOutline(landmark: Landmark, margin?: number): number[][];
export function landmarkSilhouette(landmark: Landmark): [number, number][];
export function isNightInDushanbe(date?: Date): boolean;

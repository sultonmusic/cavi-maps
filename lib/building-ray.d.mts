/** [east, north] metres, or [east, north, up] for the camera. */
export type Metres = [number, number];
export type Camera = [number, number, number];
/** The tightest rectangle around a footprint: centre, unit vector along the long side, half sides (long first). */
export type RoofBox = { centre: [number, number]; along: [number, number]; half: [number, number]; fill: number };
export type RoofShape = 'gabled' | 'hipped' | 'pyramidal';
export type Frame = (point: readonly number[]) => [number, number];

export const EARTH_CIRCUMFERENCE: number;
export const ROOF_FILL: number;
export const ROOF_PITCH: number;
export const ROOF_CAP: number;

export function mercator(lon: number, lat: number): [number, number];
export function metricFrame(originLon: number, originLat: number, scaleLat?: number): Frame;
export function closeRing<T extends readonly number[]>(ring: T[]): T[];
export function ringCentre(ring: readonly (readonly number[])[]): [number, number];
export function insideRing(point: readonly number[], ring: readonly (readonly number[])[]): boolean;
export function insideRings(point: readonly number[], rings: readonly (readonly (readonly number[])[])[]): boolean;
export function raySolid(camera: readonly number[], ground: readonly number[], rings: readonly (readonly (readonly number[])[])[], base: number, top: number): number | null;
export function rayPrism(camera: readonly number[], ground: readonly number[], ring: readonly (readonly number[])[], base: number, top: number): number | null;
export function roofBox(ring: readonly (readonly number[])[]): RoofBox | null;
export function roofRise(box: RoofBox | null): number;
export function rayRoof(camera: readonly number[], ground: readonly number[], box: RoofBox, shape: RoofShape | string, base: number): number | null;
export function floorsOf(height: number): number;
export function floorsLabel(n: number): string;

export const HOUSE_UNIT: number;
export const HOUSE_TIER: number;
export const HOUSE_GROUP: number;
export type HouseIndex = { view: DataView; count: number; starts: Uint32Array; cx: Float64Array; cy: Float64Array };
export function houseGroupOf(z: number, x: number, y: number): [number, number] | null;
export function indexHouses(bytes: ArrayBuffer): HouseIndex;
export function housesInTile(index: HouseIndex, gx: number, gy: number, z: number, x: number, y: number): { ring: number[][]; height: number }[];

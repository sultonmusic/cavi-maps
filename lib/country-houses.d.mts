export const HOUSE_UNIT: number;
export const HOUSE_TIER: number;
export const HOUSE_GROUP: number;
export const MAGIC_AHB1: number;
export const MAGIC_AHB2: number;
export type HouseStyle = 'house' | 'block' | 'office' | 'hall' | 'shop';
export const HOUSE_STYLES: readonly (HouseStyle | null)[];
/** The flags bit that marks a height as estimated rather than stated. */
export const ESTIMATED: number;
/** `head` is the per-house header size: 10 bytes in AHB1, 11 in AHB2. */
export type HouseIndex = { view: DataView; count: number; starts: Uint32Array; cx: Float64Array; cy: Float64Array; head: number };
/** `outline` hashes the house's bounding box in world units: equal for duplicate outlines. */
export type TileHouse = { ring: number[][]; height: number; index: number; style: HouseStyle | null; estimated: boolean; outline: number };
export type NearHouse = { index: number; points: number[]; height: number; gap: number; style: HouseStyle | null; estimated: boolean; outline: number };
export function houseGroupOf(z: number, x: number, y: number): [number, number] | null;
export function indexHouses(bytes: ArrayBuffer): HouseIndex;
export function houseFlags(index: HouseIndex, i: number): { style: HouseStyle | null; estimated: boolean };
export function housesInTile(index: HouseIndex, gx: number, gy: number, z: number, x: number, y: number): TileHouse[];
export function housesNear(index: HouseIndex, gx: number, gy: number, x: number, y: number, radius: number): NearHouse[];

import type { Rectangle, Vec3 } from './mesh-kit.mjs';
export type FacadeStyle = 'house' | 'block' | 'office' | 'hall' | 'shop';
/** A house to dress: `ring` in local metres (x east, y north; open or closed; any winding),
    `height` exactly as its extrusion stands, `tone` 0..7 when not houseTone(id), `colour` an
    admin's #rrggbb that wins over the tone, `gap` metres from the build's focus. */
export type FacadeHouse = {
  id: string; ring: number[][]; height: number
  roof?: string | null; style?: FacadeStyle | 'none' | string | null; colour?: string | null; tone?: number | null
  storefront?: boolean; holes?: boolean; gap?: number
};
export type FacadeRange = { texture: number; first: number; count: number };
export type FacadeMesh = { decals: Float32Array; ranges: FacadeRange[]; solids: Float32Array; houses: number; skipped: number };
/** `roofOffset` metres and `roofSize` metres per repeat place the roof pattern: a roof point (x, y)
    takes it at ((x + roofOffset[0]) / roofSize, (y + roofOffset[1]) / roofSize). */
export type FacadeOptions = { solidRadius?: number; roofOffset?: [number, number] | number[]; roofSize?: number; maxDecals?: number; maxSolids?: number };
export const FLOOR: number;
export const TEXTURE: Readonly<{ shadow: 0; roof: 1; house: 2; block: 3; office: 4; hall: 5; shop: 6; door: 7 }>;
export type TextureName = 'shadow' | 'roof' | 'house' | 'block' | 'office' | 'hall' | 'shop' | 'door';
export const TEXTURE_NAMES: readonly TextureName[];
export const STYLES: readonly FacadeStyle[];
export const BAY: Readonly<Record<FacadeStyle, number>>;
export const HOUSE_TONES: readonly string[];
export const WALL_OFFSET: number;
export const DOOR_OFFSET: number;
export const TRIM: number;
export const ROOF_METRES: number;
export const WORLD_METRE: number;
export function worldRoof(x: number, y: number, scale: number): { roofSize: number; roofOffset: [number, number] };
export const MAX_DECAL_VERTICES: number;
export const MAX_SOLID_VERTICES: number;
export const LIGHT: Readonly<{ radial: number; azimuth: number; polar: number; intensity: number }>;
export const ROOF_SHADE: number;
export function lightShade(nx: number, ny: number, nz?: number): number;
export function wallShade(nx: number, ny: number): number;
export function storeys(height: number): number;
export function houseHash(id: string): number;
export function houseTone(id: string): number;
export function outlineTone(outline: number): number;
export const TONE_LIFT: number;
export function liftedHeight(height: number, tone: number): number;
export function toneColour(tone: number): Vec3;
export function classify(house: { height: number }, area: number, rect?: Rectangle | null): FacadeStyle;
export function insetPolygon(points: number[][], metres: number): number[][] | null;
export function triangulate(points: number[][]): number[] | null;
export function markStorefronts(houses: FacadeHouse[], points: number[][], reach?: number): number;
export function litBox(x: number, y: number, halfX: number, halfY: number, bottom: number, top: number, angle: number, colour: Vec3 | number[], out: number[], topColour?: Vec3 | number[]): void;
export function buildFacades(houses: FacadeHouse[], options?: FacadeOptions): FacadeMesh;

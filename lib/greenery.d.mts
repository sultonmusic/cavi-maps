import type { Vec3 } from './mesh-kit.mjs';
export type Tree = { x: number; y: number; height: number; crown: number; leaf: number };
/** A street in local metres, with its asphalt lanes as in LiveRoad. */
export type LocalRoad = { id: string; line: number[][]; asphalt: number; oneway?: boolean };
export const STREET_TREES: boolean;
export const TREE_VERTICES: number;
export const TREE_STREET_METRES: number;
export function openGround(houses: number[][][], roads: LocalRoad[], trees: number[][], water?: number[][][]): (x: number, y: number) => boolean;
export function streetTrees(roads: LocalRoad[], isFree: (x: number, y: number) => boolean,
  options?: { centre?: number[]; radius?: number; spacing?: number; setback?: number; max?: number }): Tree[];
/** `offset`: the origin's place in the world-fixed tree grid, in cells (column k stands at (k - offset[0]) × cell). */
export function parkTrees(polygons: number[][][], isFree: (x: number, y: number) => boolean,
  options?: { centre?: number[]; radius?: number; cell?: number; max?: number; offset?: number[] }): Tree[];
export function worldGrid(x: number, y: number, scale: number, metres?: number): { cell: number; offset: [number, number] };
export function lowTreeTriangles(x: number, y: number, height: number, crown: number, leaf: number | Vec3, out: number[]): void;

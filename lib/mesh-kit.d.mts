export type Vec3 = [number, number, number];
export type Rectangle = { centre: [number, number]; along: [number, number]; half: [number, number]; fill: number };
export function unit(vector: Vec3): Vec3;
export const SUN: Vec3;
export const LEAVES: Vec3[];
export function facet(points: Vec3[], inside: Vec3, colour: Vec3, out: number[]): void;
export function block(x: number, y: number, halfX: number, halfY: number, bottom: number, top: number, angle: number, colour: Vec3, out: number[]): void;
export function blob(x: number, y: number, z: number, radius: number, tall: number, colour: Vec3, out: number[]): void;
export function rectangleAround(ring: [number, number][] | number[][]): Rectangle | null;

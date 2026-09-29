/** A place's pictogram (a lucide icon name, or `tooth`) and rank, 0 (always shown) to 4 (only close in). */
export type PoiStyle = { icon: string; rank: number }
export const POI_IMAGE_PREFIX: 'poi:'
export const POI_BOX: number
export const POI_DISC: { readonly cx: number; readonly cy: number; readonly outer: number; readonly ring: number }
export const POI_COLOURS: { readonly disc: string; readonly ring: string; readonly glyph: string; readonly shadow: string; readonly label: string }
export const POI_GLYPH: { readonly size: number; readonly stroke: number }
export const POI_SIZE_STOPS: readonly (readonly [number, number])[]
export const POI_MINZOOM: number
export const POI_LABEL_FONT: number
export const POI_RANK_FILTER: unknown[]
export const POI_ICON_NAMES: readonly string[]
export function poiStyle(id: string, tags: Readonly<Record<string, string | undefined>> | null | undefined): PoiStyle
/** The `limit` nearest places to (lon, lat), then up to `majors` more of the nearest with rank ≤ 1. */
export function poiNearby<T extends { id: string; lat: number; lon: number; tags?: Readonly<Record<string, string | undefined>> | null }>(places: readonly T[], lon: number, lat: number, limit?: number, majors?: number): T[]
export function poiIconScale(zoom: number): number
export function poiRadius(zoom: number): number
export function poiLabelOffset(zoom: number): number
export function poiIconSizeExpression(): unknown[]

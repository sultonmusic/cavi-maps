/* How lib/atlas-gl.ts draws the road lines of the map tiles.

   A street OpenStreetMap paves is asphalt: a grey line up to zoom 16, then drawn to scale from
   public/atlas-roads. Every other street is a plain line. scripts/flag-asphalt-roads.py gives every
   road line in the tiles its way id and marks it `asphalt` exactly when public/atlas-roads draws
   that way, so a street is drawn one way only and no plain line shows beside the asphalt.

   There is no yellow: a plain street is white, and a main road only gets a darker edge.

   Everything here is a MapLibre expression, typed `unknown` like the rest of atlas-gl's style;
   cast it `as never` where the style takes it. */
import { ASPHALT_STOPS } from './lanes.mjs'

export const ROAD_KINDS = ['road-local', 'road-secondary', 'road-main'] as const
export type RoadKind = (typeof ROAD_KINDS)[number]

const MAIN = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'])
const SECONDARY = new Set(['secondary', 'secondary_link', 'tertiary', 'tertiary_link'])
/** The tile kind of an OpenStreetMap highway, sorted as build-atlas.py and flag-asphalt-roads.py sort it. */
export const roadKind = (highway?: string | null): RoadKind =>
  MAIN.has(highway ?? '') ? 'road-main' : SECONDARY.has(highway ?? '') ? 'road-secondary' : 'road-local'

/* A plain line is its kind's width in pixels times a scale that grows with the zoom: half up to
   zoom 10, whole from 13 to 16, then wider towards 19. The casing adds 1.5 px, 0.75 each side. */
const KIND_PIXELS: Record<RoadKind, number> = { 'road-main': 6, 'road-secondary': 5, 'road-local': 3 }
const KIND_WIDTH = ['match', ['get', 'kind'], 'road-main', KIND_PIXELS['road-main'], 'road-secondary', KIND_PIXELS['road-secondary'], KIND_PIXELS['road-local']]
const ROAD_STOPS: readonly (readonly [number, number])[] = [[10, 0.5], [13, 1], [16, 1], [19, 2.2]]
const ROAD_BASE = 1.26
const PLAIN_EDGE = 1.5

export const PLAIN_CASING = ['match', ['get', 'kind'], 'road-main', '#c9c1b2', 'road-secondary', '#d3ccbf', '#d9d3c8']
export const PLAIN_SURFACE = '#ffffff'

/** Pixels across a plain line, with its edge for the casing. MapLibre only accepts `zoom` as the input of a top-level interpolate. */
export const plainRoadWidth = (casing = false): unknown =>
  ['interpolate', ['exponential', ROAD_BASE], ['zoom'],
    ...ROAD_STOPS.flatMap(([zoom, scale]) => {
      const scaled = ['*', scale, KIND_WIDTH]
      return [zoom, casing ? ['+', PLAIN_EDGE, scaled] : scaled]
    })]

/* Ways the admin has styled are drawn from the live source alone, so the tiles hide both their
   plain and their asphalt lines. */
const IS_ROAD = ['in', ['get', 'kind'], ['literal', ROAD_KINDS]]
const unedited = (paved: readonly number[]) => paved.length ? [['!', ['in', ['get', 'way'], ['literal', [...paved]]]]] : []

/** Road lines OpenStreetMap does not pave, less the ways in `paved`. */
export const plainRoadFilter = (paved: readonly number[] = []): unknown =>
  ['all', IS_ROAD, ['!', ['has', 'asphalt']], ...unedited(paved)]

/** Road lines public/atlas-roads draws as asphalt, less the ways in `paved`. */
export const asphaltRoadFilter = (paved: readonly number[] = []): unknown =>
  ['all', IS_ROAD, ['has', 'asphalt'], ...unedited(paved)]

/** MapLibre's exponential interpolation through stops, held at both ends. */
function curve(stops: readonly (readonly [number, number])[], base: number, zoom: number) {
  if (zoom <= stops[0][0]) return stops[0][1]
  for (let i = 1; i < stops.length; i++) {
    const [z1, v1] = stops[i]
    if (zoom > z1) continue
    const [z0, v0] = stops[i - 1]
    return v0 + (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1) * (v1 - v0)
  }
  return stops[stops.length - 1][1]
}
// The kerb line shrinks with the road, so a country view stays legible.
const kerb = (width: number) => Math.min(2.2, Math.max(0.5, width * 0.3))
const round = (value: number) => Math.round(value * 1000) / 1000

/** Pixels across a plain line of `kind` at `zoom`, as plainRoadWidth draws it. */
export const plainPixels = (kind: RoadKind, zoom: number, casing = false) =>
  KIND_PIXELS[kind] * curve(ROAD_STOPS, ROAD_BASE, zoom) + (casing ? PLAIN_EDGE : 0)

/** Pixels across a two-lane asphalt line at `zoom` (ASPHALT_STOPS, with the kerb for the casing). */
export const asphaltPixels = (zoom: number, casing = false) =>
  curve(ASPHALT_STOPS.map(([z, width]) => [z, width + (casing ? kerb(width) : 0)] as const), 2, zoom)

/* A stop at every whole zoom the asphalt line is drawn at. MapLibre evaluates a width that depends
   on the feature at whole zooms and blends between them, so these are the values that count. */
const FIRST = ASPHALT_STOPS[0][0], LAST = ASPHALT_STOPS[ASPHALT_STOPS.length - 1][0]
const ZOOMS = Array.from({ length: LAST - FIRST + 1 }, (_, i) => FIRST + i)

/**
 * Pixels across an asphalt line from the tiles, below zoom 16 where the to-scale asphalt takes
 * over. A main or secondary road is never thinner than its plain line was, so the country and
 * region views keep their weight now that paved roads are grey; a street keeps the asphalt width.
 * Lines without `kind` (the admin's live streets, unless they carry one) keep the asphalt width.
 */
export function asphaltLineWidth(casing = false): unknown {
  return ['interpolate', ['exponential', 2], ['zoom'],
    ...ZOOMS.flatMap(zoom => {
      const own = asphaltPixels(zoom, casing)
      const at = (kind: RoadKind) => round(Math.max(own, plainPixels(kind, zoom, casing)))
      return [zoom, ['match', ['get', 'kind'], 'road-main', at('road-main'), 'road-secondary', at('road-secondary'), round(own)]]
    })]
}

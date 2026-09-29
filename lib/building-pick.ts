/* Which building a tap lands on as the camera sees it. In a tilted view the tapped pixel is a line of
   sight from the camera down to the ground, and the point MapLibre reports for the tap is where that
   line meets the ground: behind any building the finger is actually on. So MapLibre only names the
   buildings drawn near the finger, and each of them (plus the pitched roofs and hand-made landmarks
   that MapLibre cannot query) is tested against the line of sight; the front-most one wins.

   Only MapLibre's types are imported, so scripts/check-building-pick.mjs runs this file in node
   against a stand-in map. */
import type { Map as GLMap, MapGeoJSONFeature } from 'maplibre-gl'
import {
  EARTH_CIRCUMFERENCE, ROOF_CAP, closeRing, mercator, metricFrame, rayRoof, raySolid, ringCentre, roofBox,
  type Frame, type RoofBox, type RoofShape,
} from './building-ray.mjs'

export type BuildingSource = 'houses' | 'admin' | 'country' | 'landmark'
/** A building as the app knows it. Keys: 'ms:<n>' and 'osm:<way|relation>/<id>' (Shaydon), 'admin:<id>',
    'cty:<gx>-<gy>:<n>' (record n of public/atlas-houses/<gx>-<gy>.bin) and 'landmark:<id>'. */
export type BuildingRecord = {
  key: string
  source: BuildingSource
  /** The whole outline in lon/lat, open or closed. GeoJSON tiles cut outlines at their edges, so a
      catalogue hands out its own copy where it has one. */
  ring: number[][]
  /** Courtyards, when the outline has any. */
  holes?: number[][][]
  /** Metres to the top of the walls. */
  height: number
  number?: number
  street?: string
  label?: string
  /** Floors, when the admin or OpenStreetMap gives them. */
  levels?: number
  /** The height comes from a source, not from an estimate. */
  stated?: boolean
}
/** Something MapLibre cannot query: walls standing from the ground to `top` metres (a landmark), and/or a
    pitched `roof` set on walls `base` metres tall, as the map's own roof mesh draws it. */
export type BuildingSolid = { record: BuildingRecord; top?: number; roof?: RoofShape; base?: number }
export type BuildingCatalogue = {
  /** Fill-extrusion layers whose features carry a `key` property. */
  layers: readonly string[]
  /** The app's own record for a key, with the whole outline. */
  known: (key: string) => BuildingRecord | null | undefined
  /** Pitched roofs and hand-made meshes, asked for once per tap. */
  solids: () => Iterable<BuildingSolid>
}
export type BuildingHit = BuildingRecord & {
  number: number
  street: string
  label: string
  /** The closed outline and its middle, averaged over the corners exactly as page.tsx's house search does,
      so a tapped house and the same house found by search share one place id. */
  ring: number[][]
  lat: number
  lon: number
  /** Metres from the camera to where the line of sight meets the building; Infinity when unknown. */
  distance: number
  /** The line of sight under the finger itself meets the building, not only one a few pixels aside. */
  exact: boolean
  shape: { type: 'Polygon'; coordinates: number[][][] }
}

/** Pixels a finger may miss a building by. */
export const SLACK = 8
/** The line of sight under the finger first; the four around it only when that one meets nothing. */
const AROUND: readonly (readonly [number, number])[] = [[SLACK, 0], [-SLACK, 0], [0, SLACK], [0, -SLACK]]
/** Coincident outlines (an admin drawing over a surveyed footprint) are one hit: the more specific source wins. */
const TIE = 0.25
const RANK: Record<BuildingSource, number> = { landmark: 0, admin: 1, houses: 2, country: 3 }
/** A wall of unknown height, as the map draws it (atlas-gl APPROXIMATE_HEIGHT). */
const FALLBACK_HEIGHT = 4

export const countryKey = (tile: string, index: number) => `cty:${tile}:${index}`
/** Shipped Shaydon footprints: the only ones whose floors the admin can store (firestore.rules buildingInfo). */
export const isShaydonKey = (key: string) => key.startsWith('ms:') || key.startsWith('osm:')

type Camera = [number, number, number]
type Ray = { ground: [number, number]; length: number }
/** `ahead`: where the camera looks, the map's centre on the ground, in the same metres. */
type View = { local: Frame; camera: Camera; ahead: [number, number] }
type Candidate = {
  record: BuildingRecord
  /** Walls from the ground to here. */
  top: number
  roof: RoofShape | null
  base: number
  /** Outline and courtyards in the view's metres, and the roof's rectangle, worked out on first use. */
  rings: number[][][] | null
  box: RoofBox | null
  /** Bounds of the outline in the view's metres: west, south, east, north. */
  bounds: [number, number, number, number] | null
}

/** Where the camera is, in metres east and north of the point on the ground under it. MapLibre measures
    heights at the latitude of the map's centre, so horizontal metres use that latitude too. */
function viewOf(map: GLMap): View | null {
  try {
    const transform = map.transform, eye = transform.getCameraLngLat(), altitude = transform.getCameraAltitude()
    if (!(altitude > 0) || !Number.isFinite(eye.lng) || !Number.isFinite(eye.lat)) return null
    const centre = map.getCenter(), local = metricFrame(eye.lng, eye.lat, centre.lat)
    return { local, camera: [0, 0, altitude], ahead: local([centre.lng, centre.lat]) }
  } catch {
    return null
  }
}

/** The line of sight through screen point x, y, as the ground point it lands on; null above the horizon. */
function rayOf(map: GLMap, view: View, x: number, y: number): Ray | null {
  try {
    const ground = map.unproject([x, y])
    if (!Number.isFinite(ground.lng) || !Number.isFinite(ground.lat)) return null
    const g = view.local([ground.lng, ground.lat]), [ax, ay] = view.ahead, altitude = view.camera[2]
    // Above the horizon the line never meets the ground, and MapLibre reports where its backward extension
    // does, behind the camera (a line through the eye projects to one pixel either way, so projecting the
    // point back cannot tell). The camera looks at the map's centre, so a real ground point lies ahead of it.
    if (!(g[0] * ax + g[1] * ay + altitude * altitude > 0)) return null
    const length = Math.hypot(g[0], g[1], altitude)
    return Number.isFinite(length) ? { ground: g, length } : null
  } catch {
    return null
  }
}

function sourceOf(key: string): BuildingSource {
  return key.startsWith('cty:') ? 'country' : key.startsWith('admin:') ? 'admin' : key.startsWith('landmark:') ? 'landmark' : 'houses'
}

/** The record for a queried feature: the catalogue's own, else what the feature itself carries. The
    country tiles never cut an outline (each house lives in the one tile holding its middle), so their
    queried outlines are whole. */
function recordOf(feature: MapGeoJSONFeature, catalogue: BuildingCatalogue): BuildingRecord | null {
  const properties = feature.properties ?? {}, key = typeof properties.key === 'string' ? properties.key : ''
  if (!key) return null
  const known = catalogue.known(key)
  if (known) return known
  const geometry = feature.geometry
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.type === 'MultiPolygon' ? geometry.coordinates[0] : null
  if (!rings?.[0] || rings[0].length < 3) return null
  const height = Number(properties.height), number = Number(properties.house)
  return {
    key, source: sourceOf(key), ring: rings[0], ...(rings.length > 1 ? { holes: rings.slice(1) } : {}),
    height: height > 0 ? height : FALLBACK_HEIGHT, stated: Number(properties.stated) > 0,
    ...(number > 0 ? { number } : {}),
    ...(typeof properties.street === 'string' && properties.street ? { street: properties.street } : {}),
    ...(typeof properties.label === 'string' && properties.label ? { label: properties.label } : {}),
  }
}

function candidate(record: BuildingRecord, top: number): Candidate {
  return { record, top, roof: null, base: 0, rings: null, box: null, bounds: null }
}

/** How far along `ray` (0 at the camera, 1 on the ground) it first meets the candidate, or null. */
function meet(item: Candidate, view: View, ray: Ray): number | null {
  const camera = view.camera, [gx, gy] = ray.ground
  if (!item.bounds) {
    // The outline's bounds from its lon/lat bounds: metres east grow with longitude alone and metres north
    // with latitude alone, so two corners are enough.
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    for (const point of item.record.ring) {
      if (point[0] < west) west = point[0]
      if (point[0] > east) east = point[0]
      if (point[1] < south) south = point[1]
      if (point[1] > north) north = point[1]
    }
    if (!(west <= east && south <= north)) return null
    const [x0, y0] = view.local([west, south]), [x1, y1] = view.local([east, north])
    item.bounds = [x0, y0, x1, y1]
  }
  // The line is above the building's highest point until t = 1 - highest / altitude; after that it runs
  // from there to the ground point, and only meets the building if that stretch crosses its bounds.
  const highest = Math.max(item.top, item.roof ? item.base + ROOF_CAP : 0)
  const from = Math.max(0, 1 - highest / camera[2])
  const [west, south, east, north] = item.bounds
  if (Math.max(gx * from, gx) < west || Math.min(gx * from, gx) > east || Math.max(gy * from, gy) < south || Math.min(gy * from, gy) > north) return null
  if (!item.rings) {
    item.rings = [item.record.ring, ...(item.record.holes ?? [])].map(ring => ring.map(view.local))
    item.box = item.roof ? roofBox(item.rings[0]) : null
  }
  let t = raySolid(camera, ray.ground, item.rings, 0, item.top)
  if (item.box && item.roof) {
    const roof = rayRoof(camera, ray.ground, item.box, item.roof, item.base)
    if (roof !== null && (t === null || roof < t)) t = roof
  }
  return t
}

function hitOf(record: BuildingRecord, distance: number, exact: boolean): BuildingHit {
  const ring = closeRing(record.ring), [lon, lat] = ringCentre(ring), holes = (record.holes ?? []).map(closeRing)
  return {
    ...record, number: record.number ?? 0, street: record.street ?? '', label: record.label ?? '',
    ring, lat, lon, distance, exact, shape: { type: 'Polygon', coordinates: [ring, ...holes] },
  }
}

/** The building under a screen point as the camera sees it: the front-most wall, roof or landmark along
    the line of sight, never the ground behind it. Null when the finger is on no building. */
export function pickBuilding(map: GLMap, point: { x: number; y: number }, catalogue: BuildingCatalogue): BuildingHit | null {
  const candidates = new Map<string, Candidate>()
  let first: BuildingRecord | null = null
  try {
    const layers = catalogue.layers.filter(id => map.getLayer(id))
    if (layers.length) {
      const reach = SLACK + 1
      const box: [[number, number], [number, number]] = [[point.x - reach, point.y - reach], [point.x + reach, point.y + reach]]
      for (const feature of map.queryRenderedFeatures(box, { layers })) {
        const key = feature.properties?.key
        if (typeof key !== 'string' || !key || candidates.has(key)) continue
        const record = recordOf(feature, catalogue)
        if (!record) continue
        first ??= record
        candidates.set(key, candidate(record, record.height))
      }
    }
  } catch { /* the style is still loading */ }
  try {
    for (const solid of catalogue.solids()) {
      const { record } = solid
      let item = candidates.get(record.key)
      if (!item) candidates.set(record.key, item = candidate(record, record.height))
      if (typeof solid.top === 'number' && solid.top > item.top) item.top = solid.top
      if (solid.roof && typeof solid.base === 'number' && solid.base > 0) { item.roof = solid.roof; item.base = solid.base }
    }
  } catch { /* a mesh layer that is not ready yet: its buildings are simply not tappable this time */ }
  if (!candidates.size) return null

  const view = viewOf(map)
  if (view) {
    let sighted = false
    for (const offsets of [[[0, 0] as const], AROUND]) {
      let best: Candidate | null = null, bestDistance = Infinity
      for (const [dx, dy] of offsets) {
        const ray = rayOf(map, view, point.x + dx, point.y + dy)
        if (!ray) continue
        sighted = true
        for (const item of candidates.values()) {
          const t = meet(item, view, ray)
          if (t === null) continue
          const distance = t * ray.length
          if (!best || distance < bestDistance - TIE || (distance < bestDistance + TIE && RANK[item.record.source] < RANK[best.record.source])) {
            best = item
            bestDistance = distance
          }
        }
      }
      if (best) return hitOf(best.record, bestDistance, offsets.length === 1)
    }
    if (sighted) return null
  }
  // No line of sight to work with (a projection without a camera): trust MapLibre's own nearest-first order.
  return first ? hitOf(first, Infinity, false) : null
}

/** Metres from the camera to a point on the ground, in the same measure as BuildingHit.distance. */
export function groundDistance(map: GLMap, lon: number, lat: number): number {
  const view = viewOf(map)
  if (!view) return Infinity
  const [x, y] = view.local([lon, lat]), distance = Math.hypot(x, y, view.camera[2])
  return Number.isFinite(distance) ? distance : Infinity
}

/** Whether the tapped building stands in front of a point on the ground, such as a label's anchor: names
    are painted over everything, and a street name showing across a building that stands in front of that
    street is not what the finger meant. */
export function standsBefore(map: GLMap, hit: BuildingHit, lon: number, lat: number): boolean {
  return hit.exact && Number.isFinite(hit.distance) && hit.distance + 2 < groundDistance(map, lon, lat)
}

/** Screen pixels from a point on the ground to the same point `metres` up, to lift a pin onto a roof.
    Metres up are the extrusions' own: measured at the latitude of the map's centre. */
export function liftOffset(map: GLMap, lon: number, lat: number, metres: number): [number, number] {
  try {
    const transform = map.transform
    const m = transform.getProjectionDataForCustomLayer(false).mainMatrix as unknown as ArrayLike<number>
    const [x, y] = mercator(lon, lat), up = metres / (EARTH_CIRCUMFERENCE * Math.cos(map.getCenter().lat * Math.PI / 180))
    const clip = (z: number) => {
      const w = m[3] * x + m[7] * y + m[11] * z + m[15]
      return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, w]
    }
    const low = clip(0), high = clip(up)
    if (!(low[2] > 0) || !(high[2] > 0)) return [0, 0]
    const dx = (high[0] - low[0]) / 2 * transform.width, dy = (low[1] - high[1]) / 2 * transform.height
    return Number.isFinite(dx) && Number.isFinite(dy) ? [dx, dy] : [0, 0]
  } catch {
    return [0, 0]
  }
}

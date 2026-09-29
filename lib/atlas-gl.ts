/* Atlas on MapLibre GL.
 *
 * The tiles are the same locally processed OpenStreetMap bundles the canvas
 * renderer used; `atlas://` re-encodes them as MVT in the browser, so rotation,
 * tilt and extruded buildings cost no new data and no second copy of the map.
 *
 * Text is drawn on a canvas above the map rather than through MapLibre symbol
 * layers: that keeps the original typography and needs no glyph server, which
 * an offline-first map cannot rely on. Place pictograms are an icons-only symbol
 * layer whose images are drawn in the browser on demand (lib/poi-draw.ts), so
 * they need neither glyphs nor a sprite sheet. */
import { siteUrl } from './site-url'
import { Map as GLMap, Marker, LngLatBounds, MercatorCoordinate, ScaleControl, addProtocol, type CustomLayerInterface, type GeoJSONSource, type MapMouseEvent, type RequestParameters, type StyleSpecification } from 'maplibre-gl'
import { encodeTile, type MvtFeature, type MvtLayer } from './mvt'
import { houseGroupOf, housesInTile, indexHouses, type HouseIndex } from './country-houses.mjs'
import { bindSolid, composeMatrix, solidProgram, unbindSolid, type SolidProgram } from './gl-kit'
import { LEAVES, SUN, block, blob, facet, rectangleAround, unit, type Rectangle, type Vec3 } from './mesh-kit.mjs'
import { houseTone, liftedHeight, outlineTone } from './facades.mjs'
import { BUILDING_COLOUR, BUILDING_LIGHT, detailLayer } from './detail-layer'
import { ASPHALT_STOPS, carriagewayMetres, laneAt, laneLines, lanePieces, laneSegments, offsetLine, ribbon, streetAt, streetCrossings, zebra, type LaneSpot } from './lanes.mjs'
import { keepRight, type Mode } from './travel.mjs'
import { POI_COLOURS, POI_IMAGE_PREFIX, POI_MINZOOM, POI_RANK_FILTER, poiIconSizeExpression, poiLabelOffset } from './poi-icons.mjs'
import { addPoiImage, poiIconBoxes, poiPlacement } from './poi-draw'
import { countryKey, liftOffset, pickBuilding, standsBefore, type BuildingCatalogue, type BuildingRecord, type BuildingSolid } from './building-pick'

type Bundle = Record<string, RawFeature[]>
type RawFeature = [string, number, number[][][], { style?: string; way?: number; offsets?: number[] }?]

/** An admin street: `asphalt` is 0 for one shared lane or 1–6 lanes each way (on a one-way carriageway, its one way). */
export type LiveRoad = { coordinates: number[][]; asphalt: number; oneway?: boolean; id: string }
export type BuildingData = {
  origin: [number, number]; scale: number; buildings: number[][]
  streets?: string[]; street?: number[]; number?: number[]
}
export type AtlasLabel = { lon: number; lat: number; name: string; kind: string; minzoom: number; maxzoom: number | null; owner?: string; offset?: number; priority?: number }
export type LabelHit = { name: string; kind: string; owner?: string; lat: number; lon: number }
/** A place on the map: `icon` is a pictogram name from lib/poi-icons.mjs, `rank` 0 (always shown) to 4 (only close in). */
export type MapPoint = { id: string; lat: number; lon: number; name: string; category: string; icon?: string; rank?: number }
export type RouteLines = {
  variants: number[][][]; active: number; remaining: number[][] | null; running: boolean
  connector?: number[][] | null
  accuracy?: { centre: [number, number]; radius: number } | null
}
export type AdminBuilding = { id: string; name?: string; height?: number; levels?: number; roof?: RoofShape; geometry: { coordinates: number[][][] } }
/** One of Shaydon's OpenStreetMap buildings, shipped with its id so floors can attach to it. */
export type OsmBuilding = { id: string; name?: string; levels?: number; height?: number; ring: number[][] }
/** Landscaping to draw: paving and lawns, a fountain basin, a flagpole and park details. */
export type CityShape = {
  id: string; width?: number; height?: number; length?: number; thickness?: number; rotation?: number; surface?: 'plain' | 'tiles' | 'asphalt'
} & (
  | { kind: 'flag' | 'monument' | 'lamp' | 'bench' | 'tree' | 'bin'; geometry: { type: 'Point'; coordinates: number[] } }
  | { kind: 'path'; geometry: { type: 'LineString'; coordinates: number[][] } }
  | { kind: 'square' | 'lawn'; geometry: { type: 'LineString'; coordinates: number[][] } | { type: 'Polygon'; coordinates: number[][][] } }
  | { kind: 'fountain'; geometry: { type: 'Polygon'; coordinates: number[][][] } })
type DetailShape = Extract<CityShape, { geometry: { type: 'Point' } }>
const isDetail = (shape: CityShape): shape is DetailShape => shape.geometry.type === 'Point'
export type EditorShape = {
  type: 'Feature'
  properties: { role: 'district' | 'building' | 'business' | 'city'; id: string; published?: boolean }
  geometry: { type: 'Point'; coordinates: number[] } | { type: 'Polygon'; coordinates: number[][][] }
    | { type: 'MultiPolygon'; coordinates: number[][][][] } | { type: 'LineString'; coordinates: number[][] }
}
export type SelectionGeometry =
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'MultiLineString'; coordinates: number[][][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }

const BACKGROUND = '#f7f5ed'
const AREA_COLOURS: Record<string, string> = { rock: '#e8e6df', urban: '#f1ede5', green: '#dbe8c4', park: '#c3deb1', water: '#a7d9e9' }
const ASPHALT_SURFACE = '#a9abad'
const ASPHALT_CASING = '#ddd9ce'
const MARKING = '#f3f3ef'
/* Shaydon's footprints carry no surveyed height. A wall is as tall as the admin, or an
   OpenStreetMap tag, says; without that every wall uses one stated approximation
   rather than a per-building guess. */
export const APPROXIMATE_HEIGHT = 4
export const FLOOR_HEIGHT = 3
export type RoofShape = 'gabled' | 'hipped' | 'pyramidal'
export type HeightInfo = { levels?: number; height?: number; roof?: RoofShape }
/** A stated height wins; then floors at 3 m each plus a metre of plinth and parapet. */
export function wallHeight(info?: HeightInfo | null) {
  const height = info?.height, levels = info?.levels
  if (typeof height === 'number' && height >= 1 && height <= 500) return height
  if (typeof levels === 'number' && Number.isInteger(levels) && levels >= 1 && levels <= 60) return levels * FLOOR_HEIGHT + 1
  return APPROXIMATE_HEIGHT
}
/** Whether wallHeight() takes the height from `info` rather than falling back to the approximation. */
function heightStated(info?: HeightInfo | null) {
  const height = info?.height, levels = info?.levels
  return (typeof height === 'number' && height >= 1 && height <= 500) || (typeof levels === 'number' && Number.isInteger(levels) && levels >= 1 && levels <= 60)
}
/* Houses stay standing from the moment they appear until they fade out: no switch
   to flat footprints. Far up a tilted view the tiles are several zooms coarser than
   the map, so the layers reach down to those tiles and the fade follows the map zoom;
   otherwise houses arrive a whole tile at a time as the distance comes closer. */
const HOUSE_MINZOOM = 13
const HOUSE_OPACITY = ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1]
const PAVING = 'atlas-paving'

const EMPTY = { type: 'FeatureCollection' as const, features: [] }
const tierFor = (z: number) => (z < 10 ? 7 : z < 13 ? 10 : 13)
const unproject = (nx: number, ny: number): [number, number] =>
  [nx * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * ny))) * 180 / Math.PI]

/* Streets without asphalt stay slimmer than any to-scale asphalt from zoom 16, so a street drawn
   both ways never shows its plain line along the asphalt's edges. */
const ROAD_STOPS: [number, number][] = [[10, 0.5], [13, 1], [16, 1], [19, 2.2]]
const KIND_WIDTH = ['match', ['get', 'kind'], 'road-main', 6, 'road-secondary', 5, 3]

/** MapLibre only accepts `zoom` as the input of a top-level interpolate. */
const asphaltWidth = (casing = false): unknown =>
  ['interpolate', ['exponential', 2], ['zoom'],
    ...ASPHALT_STOPS.flatMap(([zoom, width]) => {
      // The kerb line shrinks with the road, so a country view stays legible.
      const edge = casing ? Math.min(2.2, Math.max(0.5, width * 0.3)) : 0
      return [zoom, edge + width]
    })]
/* Zoomed out, asphalt is a line wider than life; closer in it hands over to outlines drawn to
   scale. Both depend on the camera's zoom alone, so tiles of different detail in a tilted view
   agree on how wide a street is. */
const FADE_OUT = ['step', ['zoom'], 1, 16, 0]
const FADE_IN = ['step', ['zoom'], 0, 16, 1]
const MARK_WIDTH = ['interpolate', ['linear'], ['zoom'], 16, 0.6, 19, 1.8]

const roadWidth = (casing = 0): unknown =>
  ['interpolate', ['exponential', 1.26], ['zoom'],
    ...ROAD_STOPS.flatMap(([zoom, scale]) => {
      const scaled: unknown = ['*', scale, KIND_WIDTH]
      return [zoom, casing ? ['+', casing, scaled] : scaled]
    })]

/* The protocol is global to MapLibre, so its cache and tile index live at module
   scope and every map instance shares them. */
const bundles = new Map<string, Promise<Bundle>>()
let tileIndex: Promise<Set<string>> | undefined
let registered = false

export function loadTileIndex() {
  return tileIndex ??= fetch(siteUrl('/atlas-data/index.json?names=3')).then(response => {
    if (!response.ok) throw Error('Не удалось загрузить данные карты')
    return response.json()
  }).then((meta: { tiles: string[] }) => new Set(meta.tiles))
    .catch(cause => { tileIndex = undefined; throw cause })
}

function bundle(tier: number, x: number, y: number) {
  const name = `bundle-${tier}-${Math.floor(x / 4)}-${Math.floor(y / 4)}.json`
  let pending = bundles.get(name)
  if (!pending) {
    pending = fetch(siteUrl('/atlas-data/' + name)).then(response => {
      if (!response.ok) throw Error('Не удалось загрузить участок карты')
      return response.json() as Promise<Bundle>
    }).catch(cause => { bundles.delete(name); throw cause })
    bundles.set(name, pending)
    if (bundles.size > 24) bundles.delete(bundles.keys().next().value as string)
  }
  return pending
}

/* Houses across Tajikistan come from their own small binary files, fetched only where the map
   looks; a missing or unreachable file just leaves that area without houses. */
const houseFiles = new Map<string, Promise<HouseIndex>>()
let houseList: Promise<Set<string>> | undefined

function loadHouseList() {
  return houseList ??= fetch(siteUrl('/atlas-houses/index.json')).then(response => {
    if (!response.ok) throw Error('Не удалось загрузить список домов')
    return response.json()
  }).then((meta: { groups: string[] }) => new Set(meta.groups))
    .catch(cause => { houseList = undefined; throw cause })
}

function houseFile(name: string) {
  let pending = houseFiles.get(name)
  if (!pending) {
    pending = fetch(siteUrl(`/atlas-houses/${name}.bin`)).then(response => {
      if (!response.ok) throw Error('Не удалось загрузить дома участка')
      return response.arrayBuffer()
    }).then(indexHouses).catch(cause => { houseFiles.delete(name); throw cause })
    houseFiles.set(name, pending)
    if (houseFiles.size > 16) houseFiles.delete(houseFiles.keys().next().value as string)
  }
  return pending
}

/* OpenStreetMap's asphalt streets and street furniture come in files of one zoom-10 tile, each
   folder listing its files in an index. */
const ROAD_TIER = 10
const tileLists = new Map<string, Promise<Set<string>>>()

function loadTileList(folder: string) {
  let list = tileLists.get(folder)
  if (!list) {
    list = fetch(siteUrl(`/${folder}/index.json`)).then(response => {
      if (!response.ok) throw Error('Не удалось загрузить список участков')
      return response.json()
    }).then((meta: { groups: string[] }) => new Set(meta.groups))
    list.catch(() => tileLists.delete(folder))
    tileLists.set(folder, list)
  }
  return list
}

/** Re-project one tier tile's features into the requested child tile. */
function build(features: RawFeature[], offsetX: number, offsetY: number, factor: number): MvtLayer[] {
  const size = 4096 / factor
  const low = -256 / factor, high = size + 256 / factor
  const areas: MvtFeature[] = [], lines: MvtFeature[] = [], buildings: MvtFeature[] = []
  for (const feature of features) {
    const [kind, polygon, rings, style] = feature
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const ring of rings) for (const [x, y] of ring) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    if (x1 - offsetX * size < low || x0 - offsetX * size > high) continue
    if (y1 - offsetY * size < low || y0 - offsetY * size > high) continue
    const moved = rings.map(ring => ring.map(([x, y]) => [
      Math.round((x - offsetX * size) * factor),
      Math.round((y - offsetY * size) * factor),
    ]))
    const properties: Record<string, string | number> = { kind }
    if (style?.style === 'asphalt') {
      properties.asphalt = 1
      if (style.way !== undefined) properties.way = style.way
    }
    const shape: MvtFeature = { type: polygon ? 3 : 2, rings: moved, properties }
    if (kind === 'building') buildings.push(shape)
    else if (polygon) areas.push(shape)
    else lines.push(shape)
  }
  return [{ name: 'areas', features: areas }, { name: 'lines', features: lines }, { name: 'buildings', features: buildings }]
}

/* Zoomed out past the coarsest tier, one tile gathers every tier tile it covers, each shrunk into
   its corner, so the widest zoom still shows the country instead of an empty background. */
async function gatherTier(available: Set<string>, tier: number, z: number, x: number, y: number): Promise<MvtLayer[]> {
  const span = 2 ** (tier - z), factor = 1 / span
  const children: [number, number][] = []
  for (let dx = 0; dx < span; dx++) for (let dy = 0; dy < span; dy++) {
    if (available.has(`${tier}-${x * span + dx}-${y * span + dy}.json`)) children.push([dx, dy])
  }
  const parts = await Promise.all(children.map(async ([dx, dy]) => {
    const cx = x * span + dx, cy = y * span + dy
    const features = (await bundle(tier, cx, cy))[`${tier}-${cx}-${cy}.json`]
    return features?.length ? build(features, -dx * factor, -dy * factor, factor) : []
  }))
  const merged: MvtLayer[] = [{ name: 'areas', features: [] }, { name: 'lines', features: [] }, { name: 'buildings', features: [] }]
  for (const part of parts) part.forEach((layer, index) => { for (const feature of layer.features) merged[index].features.push(feature) })
  return merged
}

function registerProtocol() {
  if (registered) return
  registered = true
  addProtocol('atlas', async (params: RequestParameters) => {
    const match = /^atlas:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url)
    if (!match) throw Error('Некорректный адрес участка карты')
    const z = Number(match[1]), x = Number(match[2]), y = Number(match[3])
    const tier = tierFor(z), factor = 2 ** (z - tier)
    const available = await loadTileIndex()
    if (z < tier) return { data: encodeTile(await gatherTier(available, tier, z, x, y)) }
    const parentX = Math.floor(x / factor), parentY = Math.floor(y / factor)
    const key = `${tier}-${parentX}-${parentY}.json`
    if (!available.has(key)) return { data: new Uint8Array(0) }
    const features = (await bundle(tier, parentX, parentY))[key]
    if (!features?.length) return { data: new Uint8Array(0) }
    return { data: encodeTile(build(features, x - parentX * factor, y - parentY * factor, factor)) }
  })
  addProtocol('houses', async (params: RequestParameters) => {
    const match = /^houses:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url)
    const z = Number(match?.[1]), x = Number(match?.[2]), y = Number(match?.[3])
    const group = match ? houseGroupOf(z, x, y) : null
    if (!group) return { data: new Uint8Array(0) }
    try {
      const name = `${group[0]}-${group[1]}`
      if (!(await loadHouseList()).has(name)) return { data: new Uint8Array(0) }
      const houses = housesInTile(await houseFile(name), group[0], group[1], z, x, y)
      const features: MvtFeature[] = houses.map(house => {
        // Tone and height exactly as lib/detail-layer.ts dresses the same house. Each house keeps its record
        // number as its key, so a tap can name it; `stated` marks a height a source gives, never an estimate.
        const tone = outlineTone(house.outline)
        const properties: Record<string, number | string> = { height: liftedHeight(house.height || APPROXIMATE_HEIGHT, tone), tone, key: countryKey(name, house.index) }
        if (house.height && !house.estimated) properties.stated = 1
        return { type: 3 as const, rings: [house.ring], properties }
      })
      return { data: encodeTile([{ name: 'houses', features }]) }
    } catch {
      return { data: new Uint8Array(0) }
    }
  })
}

const LABEL_RANK: Record<string, number> = { country: 0, city: 1, town: 2, village: 3, hamlet: 4, neighbourhood: 5, district: 5, place: 6, road: 7, house: 8 }

/* My position: a solid chevron standing in the map's own 3D space. A flat marker all
   but vanishes into the road under a steep driving camera; the ridge and walls of this
   one stay readable at any tilt, and it hides behind houses like everything else. */
const ARROW_PIXELS = 44
const ARROW_ROOF: Vec3 = [0.1, 0.5, 0.9]
const ARROW_WALL: Vec3 = [0.04, 0.33, 0.66]

/** A chevron one unit long (x right, y forward, z up) as x, y, z and premultiplied
    r, g, b, a. Shadow and halo come first: they are drawn without writing depth, so
    the solid stands on them instead of fighting them. */
function arrowMesh() {
  const ground: number[] = [], solid: number[] = []
  const put = (into: number[], [x, y, z]: Vec3, [r, g, b]: Vec3, a = 1) => { into.push(x, y, z, r * a, g * a, b * a, a) }
  const light = unit([-0.5, -0.35, 0.8])
  const lit = (colour: Vec3, [nx, ny, nz]: Vec3): Vec3 => {
    const shade = 0.45 + 0.65 * Math.max(0, nx * light[0] + ny * light[1] + nz * light[2])
    return [Math.min(1, colour[0] * shade), Math.min(1, colour[1] * shade), Math.min(1, colour[2] * shade)]
  }
  // A soft shadow: darkest beneath the arrow, gone at its rim.
  const steps = 24
  for (let i = 0; i < steps; i++) {
    const from = i / steps * Math.PI * 2, to = (i + 1) / steps * Math.PI * 2
    put(ground, [0.04, -0.12, 0], [0, 0, 0], 0.3)
    put(ground, [0.04 + Math.cos(from) * 0.62, -0.12 + Math.sin(from) * 0.8, 0], [0, 0, 0], 0)
    put(ground, [0.04 + Math.cos(to) * 0.62, -0.12 + Math.sin(to) * 0.8, 0], [0, 0, 0], 0)
  }
  // Counter-clockwise from the tip: left wing, notch, right wing.
  const outline = [[0, 0.5], [-0.4, -0.5], [0, -0.2], [0.4, -0.5]]
  // A white halo parts the arrow from the route line it rides on.
  const halo = outline.map(([x, y]): Vec3 => [x * 1.3, (y + 0.05) * 1.3 - 0.05, 0])
  for (const i of [0, 1, 2, 0, 2, 3]) put(ground, halo[i], [1, 1, 1])
  const base = (i: number): Vec3 => [outline[i][0], outline[i][1], 0]
  // The ridge runs from the tip to the notch; the wings sit lower.
  const top = (i: number): Vec3 => [outline[i][0], outline[i][1], i % 2 ? 0.08 : 0.2]
  for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
    const p = top(a), q = top(b), r = top(c)
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]
    const [nx, ny, nz] = unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])
    const colour = lit(ARROW_ROOF, nz < 0 ? [-nx, -ny, -nz] : [nx, ny, nz])
    for (const point of [p, q, r]) put(solid, point, colour)
  }
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    // On a counter-clockwise outline, outward is to the right of each edge.
    const colour = lit(ARROW_WALL, unit([outline[j][1] - outline[i][1], outline[i][0] - outline[j][0], 0]))
    for (const point of [base(i), base(j), top(j), base(i), top(j), top(i)]) put(solid, point, colour)
  }
  return { data: new Float32Array([...ground, ...solid]), ground: ground.length / 7, solid: solid.length / 7 }
}

export type ArrowPosition = { lon: number; lat: number; heading: number | null }

function locationArrow(map: GLMap) {
  const mesh = arrowMesh()
  let position: { lon: number; lat: number; heading: number; lane: number } | null = null
  let solid: SolidProgram | null = null, buffer: WebGLBuffer | null = null
  const layer: CustomLayerInterface = {
    id: 'location-arrow', type: 'custom', renderingMode: '3d',
    onAdd(_map, gl) {
      solid = solidProgram(gl)
      buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW)
    },
    onRemove(_map, gl) {
      if (solid) gl.deleteProgram(solid.program)
      gl.deleteBuffer(buffer)
      solid = null
      buffer = null
    },
    render(gl, { defaultProjectionData }) {
      if (!position || !solid) return
      // One arrow length in mercator units: the same size on screen at every zoom.
      const size = ARROW_PIXELS / (512 * 2 ** map.getZoom())
      const centre = MercatorCoordinate.fromLngLat([position.lon, position.lat])
      const angle = position.heading * Math.PI / 180
      const cos = Math.cos(angle) * size, sin = Math.sin(angle) * size
      // In its lane, or on the kerb or pavement: `lane` metres right of the street's centre line.
      const shift = position.lane * centre.meterInMercatorCoordinateUnits()
      const x = centre.x + Math.cos(angle) * shift, y = centre.y + Math.sin(angle) * shift
      // Right, forward and up, into mercator units whose y grows southwards.
      const model = [cos, sin, 0, 0, sin, -cos, 0, 0, 0, 0, size, 0, x, y, 0, 1]
      bindSolid(gl, solid, buffer, composeMatrix(defaultProjectionData.mainMatrix, model))
      gl.depthMask(false)
      gl.drawArrays(gl.TRIANGLES, 0, mesh.ground)
      gl.depthMask(true)
      gl.drawArrays(gl.TRIANGLES, mesh.ground, mesh.solid)
      unbindSolid(gl, solid)
    },
  }

  /** Where I am, or null for no arrow. A fix without a heading keeps the last one. */
  function set(next: (ArrowPosition & { lane?: number }) | null) {
    position = next ? { lon: next.lon, lat: next.lat, heading: next.heading ?? position?.heading ?? 0, lane: next.lane ?? 0 } : null
    map.triggerRepaint()
  }

  return { layer, set, heading: () => position?.heading ?? 0 }
}

/* Pitched roofs. MapLibre extrudes flat-topped walls only, so a roof is its own mesh set on
   top of them. It is fitted to the footprint's tightest rectangle, which is only honest when
   the footprint nearly fills that rectangle; any other shape keeps its flat top. */
type Roof = { ring: number[][]; shape: RoofShape; base: number; key?: string }
const ROOF_FILL = 0.8
const ROOF_PITCH = Math.tan(30 * Math.PI / 180)
const ROOF_COLOUR: Vec3 = [0.6, 0.55, 0.5]
const GABLE_COLOUR: Vec3 = [0.87, 0.83, 0.77]

/** East and north metres from `origin`, measured in the map's own projection. */
function localMetres(ring: number[][], origin: MercatorCoordinate): [number, number][] {
  const scale = origin.meterInMercatorCoordinateUnits()
  return ring.map(([lon, lat]) => {
    const point = MercatorCoordinate.fromLngLat([lon, lat])
    return [(point.x - origin.x) / scale, (origin.y - point.y) / scale]
  })
}

/** Whether a footprint is near enough to a rectangle to carry a pitched roof. */
export function roofFits(ring: number[][]) {
  if (ring.length < 4) return false
  const box = rectangleAround(localMetres(ring, MercatorCoordinate.fromLngLat([ring[0][0], ring[0][1]])))
  return !!box && box.fill >= ROOF_FILL
}

/** Triangles for one roof, in local metres, set on walls `base` metres tall. */
function roofTriangles(box: Rectangle, shape: RoofShape, base: number, out: number[]) {
  const [cx, cy] = box.centre, [ex, ey] = box.along, [a, b] = box.half
  const top = base + Math.min(b * ROOF_PITCH, 8)
  const at = (u: number, v: number, z: number): Vec3 => [cx + ex * u - ey * v, cy + ey * u + ex * v, z]
  const light = unit([-0.35, -0.5, 0.8])
  const face = (colour: Vec3, ...points: Vec3[]) => {
    const [p, q, r] = points
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]
    let normal = unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])
    // Faces look away from the middle of the roof, so the light falls on their outside.
    const middle = points.reduce((sum, point) => [sum[0] + point[0] - cx, sum[1] + point[1] - cy, sum[2] + point[2] - base], [0, 0, 0])
    if (normal[0] * middle[0] + normal[1] * middle[1] + normal[2] * middle[2] < 0) normal = [-normal[0], -normal[1], -normal[2]]
    const shade = 0.5 + 0.55 * Math.max(0, normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2])
    const lit = colour.map(channel => Math.min(1, channel * shade))
    for (let i = 1; i + 1 < points.length; i++) for (const point of [points[0], points[i], points[i + 1]]) out.push(...point, lit[0], lit[1], lit[2], 1)
  }
  if (shape === 'gabled') {
    const start = at(-a, 0, top), end = at(a, 0, top)
    face(ROOF_COLOUR, at(-a, -b, base), at(a, -b, base), end, start)
    face(ROOF_COLOUR, at(a, b, base), at(-a, b, base), start, end)
    face(GABLE_COLOUR, at(-a, b, base), at(-a, -b, base), start)
    face(GABLE_COLOUR, at(a, -b, base), at(a, b, base), end)
  } else if (shape === 'hipped' && a - b > 0.05) {
    const start = at(b - a, 0, top), end = at(a - b, 0, top)
    face(ROOF_COLOUR, at(-a, -b, base), at(a, -b, base), end, start)
    face(ROOF_COLOUR, at(a, b, base), at(-a, b, base), start, end)
    face(ROOF_COLOUR, at(-a, b, base), at(-a, -b, base), start)
    face(ROOF_COLOUR, at(a, -b, base), at(a, b, base), end)
  } else {
    // A pyramid, which is also what a hipped roof becomes on a square.
    const apex = at(0, 0, top)
    face(ROOF_COLOUR, at(-a, -b, base), at(a, -b, base), apex)
    face(ROOF_COLOUR, at(a, -b, base), at(a, b, base), apex)
    face(ROOF_COLOUR, at(a, b, base), at(-a, b, base), apex)
    face(ROOF_COLOUR, at(-a, b, base), at(-a, -b, base), apex)
  }
}

/* A flagpole flying Tajikistan's flag: red, white and green bands in 2:3:2 with the golden
   crown in the middle. The cloth holds a still ripple, so it reads as cloth without the map
   having to repaint every frame. */
const RED: Vec3 = [0.8, 0.07, 0.07], WHITE: Vec3 = [0.97, 0.97, 0.95], GREEN: Vec3 = [0.02, 0.45, 0.18]
const FLAG_BANDS: Vec3[] = [RED, RED, WHITE, WHITE, WHITE, GREEN, GREEN]
const GOLD: Vec3 = [0.96, 0.76, 0.18], STEEL: Vec3 = [0.83, 0.85, 0.88], STONE: Vec3 = [0.72, 0.69, 0.64]

const DARK_METAL: Vec3 = [0.36, 0.38, 0.4], LAMP_GREY: Vec3 = [0.72, 0.74, 0.76], LAMP_LIGHT: Vec3 = [1, 0.96, 0.78]
const WOOD: Vec3 = [0.84, 0.66, 0.45], BARK: Vec3 = [0.45, 0.33, 0.22], BIN_GREEN: Vec3 = [0.2, 0.4, 0.3]
const BRONZE: Vec3 = [0.55, 0.5, 0.44], SPRAY: Vec3 = [0.86, 0.94, 0.99]
/** A point-like object to build as a mesh, with the sizes the admin gave it. */
type Detail = { kind: DetailShape['kind']; point: number[]; width?: number; height?: number; length?: number; thickness?: number; rotation?: number }
type Fountain = { centre: number[]; corners: number[][] }

/** A park lamp: a slim post, an arm leaning out the way `rotation` points, and a lantern. */
function lampTriangles(x: number, y: number, detail: Detail, out: number[]) {
  const height = detail.height ?? 5, angle = (detail.rotation ?? 0) * Math.PI / 180
  const east = Math.sin(angle), north = Math.cos(angle), reach = Math.min(1.2, height * 0.16)
  block(x, y, 0.14, 0.14, 0, 0.35, angle, DARK_METAL, out)
  block(x, y, 0.055, 0.055, 0.35, height, angle, LAMP_GREY, out)
  block(x + east * reach / 2, y + north * reach / 2, 0.04, reach / 2 + 0.04, height - 0.08, height, angle, LAMP_GREY, out)
  block(x + east * reach, y + north * reach, 0.16, 0.24, height - 0.3, height - 0.06, angle, LAMP_GREY, out)
  block(x + east * reach, y + north * reach, 0.12, 0.2, height - 0.36, height - 0.3, angle, LAMP_LIGHT, out)
}

/** A park bench that faces the way `rotation` points. */
function benchTriangles(x: number, y: number, detail: Detail, out: number[]) {
  const length = detail.length ?? 1.8, angle = (detail.rotation ?? 0) * Math.PI / 180, half = length / 2
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const place = (dx: number, dy: number) => [x + dx * cos + dy * sin, y - dx * sin + dy * cos]
  for (const side of [-1, 1]) {
    const [lx, ly] = place(side * (half - 0.12), 0)
    block(lx, ly, 0.04, 0.24, 0, 0.44, angle, DARK_METAL, out)
  }
  block(x, y, half, 0.22, 0.4, 0.46, angle, WOOD, out)
  const [bx, by] = place(0, -0.22)
  block(bx, by, half, 0.035, 0.5, 0.9, angle, WOOD, out)
}

/** A tree: a trunk and a faceted crown, in slightly different greens from tree to tree. */
function treeTriangles(x: number, y: number, detail: Detail, out: number[]) {
  const height = detail.height ?? 6, crown = (detail.width ?? height * 0.6) / 2
  block(x, y, 0.12, 0.12, 0, height * 0.45, 0, BARK, out)
  blob(x, y, height * 0.62, crown, height * 0.38, LEAVES[Math.abs(Math.round(x * 7 + y * 13)) % LEAVES.length], out)
}

/** A monument: a stone plinth and a stele facing the way `rotation` points. */
function monumentTriangles(x: number, y: number, detail: Detail, out: number[]) {
  const height = detail.height ?? 4, width = detail.width ?? 1.5, angle = (detail.rotation ?? 0) * Math.PI / 180
  const plinth = Math.min(1.2, height * 0.3)
  block(x, y, width / 2, width / 2, 0, plinth, angle, STONE, out)
  block(x, y, width * 0.24, width * 0.16, plinth, height, angle, BRONZE, out)
  block(x, y, width * 0.3, width * 0.22, height - 0.12, height, angle, BRONZE, out)
}

function jetTriangles(x: number, y: number, height: number, out: number[]) {
  block(x, y, 0.06, 0.06, 0.3, height, 0, SPRAY, out)
}

const STOP_GLASS: Vec3 = [0.72, 0.84, 0.88], STOP_ROOF: Vec3 = [0.3, 0.34, 0.38], STOP_SIGN: Vec3 = [0.1, 0.42, 0.82]
const SIGNAL_BODY: Vec3 = [0.16, 0.17, 0.18], LAMP_RED: Vec3 = [0.95, 0.22, 0.16], LAMP_AMBER: Vec3 = [1, 0.76, 0.12], LAMP_GREEN: Vec3 = [0.2, 0.85, 0.36]
const POOL_WATER: Vec3 = [0.6, 0.8, 0.92]

/** A bus stop: a glass-backed shelter open towards the street (`facing`), a bench inside and a sign by the kerb. */
function stopTriangles(x: number, y: number, facing: number, out: number[]) {
  const angle = facing * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  const place = (dx: number, dy: number): [number, number] => [x + dx * cos + dy * sin, y - dx * sin + dy * cos]
  const [backX, backY] = place(0, -0.7)
  block(backX, backY, 1.6, 0.04, 0.1, 2.3, angle, STOP_GLASS, out)
  for (const side of [-1, 1]) {
    for (const depth of [-0.7, 0.6]) {
      const [postX, postY] = place(side * 1.55, depth)
      block(postX, postY, 0.05, 0.05, 0, 2.4, angle, DARK_METAL, out)
    }
    const [paneX, paneY] = place(side * 1.6, -0.05)
    block(paneX, paneY, 0.03, 0.62, 0.1, 2.3, angle, STOP_GLASS, out)
  }
  const [roofX, roofY] = place(0, -0.05), [seatX, seatY] = place(0, -0.45), [signX, signY] = place(2.3, 0.9)
  block(roofX, roofY, 1.75, 0.85, 2.4, 2.55, angle, STOP_ROOF, out)
  block(seatX, seatY, 1.2, 0.2, 0.42, 0.48, angle, WOOD, out)
  block(signX, signY, 0.04, 0.04, 0, 2.7, angle, DARK_METAL, out)
  block(signX, signY, 0.28, 0.03, 2.2, 2.75, angle, STOP_SIGN, out)
}

/** A traffic light on its pole: red, amber and green in a dark housing, lit towards `facing`. */
function signalTriangles(x: number, y: number, facing: number, out: number[]) {
  const angle = facing * Math.PI / 180, front = 0.13, frontX = x + Math.sin(angle) * front, frontY = y + Math.cos(angle) * front
  block(x, y, 0.07, 0.07, 0, 3.3, angle, DARK_METAL, out)
  block(x, y, 0.17, 0.12, 2.3, 3.3, angle, SIGNAL_BODY, out)
  for (const [colour, bottom] of [[LAMP_RED, 3], [LAMP_AMBER, 2.7], [LAMP_GREEN, 2.4]] as const) block(frontX, frontY, 0.09, 0.02, bottom, bottom + 0.2, angle, colour, out)
}

/** A round fountain: a stone rim, a sheet of water and a jet, more jets in a larger basin. */
function fountainTriangles(x: number, y: number, radius: number, out: number[]) {
  const segments = 16, rim = Math.max(0.25, radius * 0.08), inner = radius - rim
  for (let i = 0; i < segments; i++) {
    const angle = (i + 0.5) / segments * Math.PI * 2, middle = radius - rim / 2
    block(x + Math.sin(angle) * middle, y + Math.cos(angle) * middle, rim / 2, Math.PI * radius / segments + 0.02, 0, 0.55, angle + Math.PI / 2, STONE, out)
  }
  const water = Array.from({ length: segments }, (_, i): Vec3 => [x + Math.sin(i / segments * Math.PI * 2) * inner, y + Math.cos(i / segments * Math.PI * 2) * inner, 0.35])
  facet(water, [x, y, 0], POOL_WATER, out)
  jetTriangles(x, y, Math.min(4, 1.2 + radius * 0.3), out)
  if (radius > 3) for (let i = 0; i < 6; i++) jetTriangles(x + Math.sin(i / 3 * Math.PI) * inner * 0.6, y + Math.cos(i / 3 * Math.PI) * inner * 0.6, 1, out)
}

const MARBLE: Vec3 = [0.93, 0.92, 0.88], GRANITE: Vec3 = [0.6, 0.44, 0.4]

/** An upright many-sided column of `radius` metres from `bottom` to `top`, capped. */
function prism(x: number, y: number, radius: number, bottom: number, top: number, colour: Vec3, out: number[], sides = 12) {
  const ring = (z: number) => Array.from({ length: sides }, (_, i): Vec3 => [x + Math.cos(i / sides * Math.PI * 2) * radius, y + Math.sin(i / sides * Math.PI * 2) * radius, z])
  const low = ring(bottom), high = ring(top), inside: Vec3 = [x, y, (bottom + top) / 2]
  for (let i = 0; i < sides; i++) facet([low[i], low[(i + 1) % sides], high[(i + 1) % sides], high[i]], inside, colour, out)
  facet(high, inside, colour, out)
}

/** The State Emblem monument in Dushanbe, 45 m high, its stair towards `facing`: a stepped granite
    podium, a white marble arch open on all four sides, a tall white column banded in gold and
    bronze, and the gold emblem, some 5 m across, on top. Simplified to blocks and columns. */
function emblemTriangles(x: number, y: number, facing: number, out: number[]) {
  const angle = facing * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  // `across` runs left to right as seen from the stair, `depth` towards it.
  const box = (across: number, depth: number, halfAcross: number, halfDepth: number, bottom: number, top: number, colour: Vec3) =>
    block(x + across * cos + depth * sin, y - across * sin + depth * cos, halfAcross, halfDepth, bottom, top, angle, colour, out)
  // Podium: three granite tiers and a stair down the front.
  for (const [half, bottom] of [[13, 0], [10, 1], [7, 2]] as const) box(0, 0, half, half, bottom, bottom + 1, GRANITE)
  for (let step = 0; step < 5; step++) box(0, 7.5 + step, 2.4, 0.5, 0, 2.5 - step * 0.5, GRANITE)
  // The arch: marble piers at the corners with slim columns, a bay open to each side under a
  // lintel trimmed in gold, a cornice and gold finials.
  const base = 3, spring = 10, roof = 12.6
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    box(sx * 3.3, sy * 3.3, 1.1, 1.1, base, roof, MARBLE)
    box(sx * 4.6, sy * 3.3, 0.2, 0.2, base, spring + 1.4, MARBLE)
    box(sx * 3.3, sy * 4.6, 0.2, 0.2, base, spring + 1.4, MARBLE)
    box(sx * 4.25, sy * 4.25, 0.15, 0.15, roof + 0.6, roof + 1.7, GOLD)
  }
  for (const side of [-1, 1]) {
    box(0, side * 3.3, 2.2, 1.1, spring, roof, MARBLE)
    box(side * 3.3, 0, 1.1, 2.2, spring, roof, MARBLE)
    box(0, side * 4.45, 2.2, 0.06, spring - 0.3, spring, GOLD)
    box(side * 4.45, 0, 0.06, 2.2, spring - 0.3, spring, GOLD)
  }
  box(0, 0, 4.7, 4.7, roof, roof + 0.6, MARBLE)
  // The column: gold and bronze drums, a white shaft, gold bands and a flared capital.
  const column: [number, number, number, Vec3][] = [
    [2.1, roof + 0.6, 14.4, GOLD], [1.6, 14.4, 16.6, BRONZE], [1.85, 16.6, 17.3, GOLD], [1.2, 17.3, 36.8, MARBLE],
    [1.5, 36.8, 37.5, GOLD], [1.3, 37.5, 38.6, MARBLE], [1.7, 38.6, 39.3, GOLD], [2.3, 39.3, 40, GOLD],
  ]
  for (const [radius, bottom, top, colour] of column) prism(x, y, radius, bottom, top, colour, out)
  // The emblem, all gold and facing the stair: a wreath open at the top, the sun rising inside it,
  // and a crown under seven stars.
  const centre = 42.2, radius = 2.2
  for (let i = 0; i < 20; i++) {
    const theta = i / 20 * Math.PI * 2
    if (Math.cos(theta) > 0.75) continue
    const height = centre + Math.cos(theta) * radius
    box(Math.sin(theta) * radius, 0, 0.36, 0.25, height - 0.36, height + 0.36, GOLD)
  }
  for (const [bottom, half] of [[41, 1.2], [41.5, 0.95], [42, 0.6]] as const) box(0, 0, half, 0.2, bottom, bottom + 0.5, GOLD)
  box(0, 0, 0.9, 0.25, 43.8, 44.4, GOLD)
  for (let i = 0; i < 7; i++) {
    const tilt = (i / 6 - 0.5) * Math.PI * 0.75, height = 43.9 + Math.cos(tilt) * 1.1
    box(Math.sin(tilt) * 1.1, 0, 0.14, 0.14, height, height + 0.28, GOLD)
  }
}

/** Street furniture from OpenStreetMap, in the models the admin's details use where one fits. */
type Thing = { kind: string; point: [number, number]; facing: number; size: number; name: string }
function thingTriangles(thing: Thing, x: number, y: number, out: number[]) {
  const size = thing.size || undefined
  if (thing.kind === 'stop') stopTriangles(x, y, thing.facing, out)
  else if (thing.kind === 'signal') signalTriangles(x, y, thing.facing, out)
  else if (thing.kind === 'fountain') fountainTriangles(x, y, thing.size || 2.5, out)
  else if (thing.kind === 'tree') treeTriangles(x, y, { kind: 'tree', point: thing.point, height: size }, out)
  else if (thing.kind === 'bench') benchTriangles(x, y, { kind: 'bench', point: thing.point, rotation: thing.facing }, out)
  else if (thing.kind === 'monument') monumentTriangles(x, y, { kind: 'monument', point: thing.point, height: size, rotation: thing.facing }, out)
  else if (thing.kind === 'flag') flagTriangles(x, y, { kind: 'flag', point: thing.point, height: size, rotation: thing.facing }, out)
  else if (thing.kind === 'emblem') emblemTriangles(x, y, thing.facing, out)
}

function detailTriangles(detail: Detail, x: number, y: number, out: number[]) {
  if (detail.kind === 'flag') flagTriangles(x, y, detail, out)
  else if (detail.kind === 'lamp') lampTriangles(x, y, detail, out)
  else if (detail.kind === 'bench') benchTriangles(x, y, detail, out)
  else if (detail.kind === 'tree') treeTriangles(x, y, detail, out)
  else if (detail.kind === 'monument') monumentTriangles(x, y, detail, out)
  else {
    block(x, y, 0.2, 0.2, 0, 0.72, 0, BIN_GREEN, out)
    block(x, y, 0.23, 0.23, 0.72, 0.78, 0, DARK_METAL, out)
  }
}

/** Plinth, pole, finial and cloth. The cloth flies the way `rotation` points (east unless set),
    rippling more towards its free end; thickness and length follow the height unless given. */
function flagTriangles(x: number, y: number, detail: Detail, out: number[]) {
  const height = detail.height ?? 12, pole = (detail.thickness ?? Math.max(0.16, height * 0.024)) / 2
  const length = detail.length ?? height * 0.3, drop = length / 2, angle = (detail.rotation ?? 90) * Math.PI / 180
  const plinth = Math.max(0.3, height * 0.03), base = Math.max(0.6, height * 0.06, pole * 3)
  block(x, y, base, base, 0, plinth, angle, STONE, out)
  block(x, y, pole, pole, plinth, height, angle, STEEL, out)
  block(x, y, pole * 1.8, pole * 1.8, height, height + pole * 3, angle, GOLD, out)
  const top = height - pole * 2, columns = 12, east = Math.sin(angle), north = Math.cos(angle)
  const at = (column: number, row: number): Vec3 => {
    const t = column / columns, away = pole + t * length, side = Math.sin(t * Math.PI * 2.2) * length * 0.05 * t
    return [x + east * away + north * side, y + north * away - east * side, top - row / 7 * drop]
  }
  for (let column = 0; column < columns; column++) for (let row = 0; row < 7; row++) {
    const colour = row === 3 && (column === 5 || column === 6) ? GOLD : FLAG_BANDS[row]
    const a = at(column, row), b = at(column + 1, row), c = at(column + 1, row + 1), d = at(column, row + 1)
    // Seen from either side, so shade by how squarely the cloth faces the sun.
    const across = unit([b[1] - a[1], a[0] - b[0], 0])
    const shade = 0.62 + 0.38 * Math.abs(across[0] * SUN[0] + across[1] * SUN[1])
    const lit = colour.map(channel => Math.min(1, channel * shade))
    for (const point of [a, b, c, a, c, d]) out.push(...point, lit[0], lit[1], lit[2], 1)
  }
}

/** A walkway as polygons: a strip per stretch and a disc at every point, which overlap
    cleanly where a single outline would fold over itself at a sharp turn. */
function walkway(line: number[][], width: number): number[][][][] {
  const [lon0, lat0] = line[0], east = 111320 * Math.cos(lat0 * Math.PI / 180), north = 110540, half = width / 2
  const degrees = (x: number, y: number) => [lon0 + x / east, lat0 + y / north]
  const points = line.map(([lon, lat]) => [(lon - lon0) * east, (lat - lat0) * north])
  const shapes: number[][][][] = []
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i], length = Math.hypot(bx - ax, by - ay)
    if (!length) continue
    const nx = (ay - by) / length * half, ny = (bx - ax) / length * half
    shapes.push([[degrees(ax + nx, ay + ny), degrees(bx + nx, by + ny), degrees(bx - nx, by - ny), degrees(ax - nx, ay - ny), degrees(ax + nx, ay + ny)]])
  }
  for (const [x, y] of points) {
    const disc = Array.from({ length: 12 }, (_, i) => degrees(x + Math.cos(i / 6 * Math.PI) * half, y + Math.sin(i / 6 * Math.PI) * half))
    shapes.push([[...disc, disc[0]]])
  }
  return shapes
}

/** A closed ring moved `metres` inwards: every edge shifts in, and neighbouring edges meet again. */
function insetRing(ring: number[][], metres: number): number[][] {
  const [lon0, lat0] = ring[0], east = 111320 * Math.cos(lat0 * Math.PI / 180), north = 110540
  const points = ring.slice(0, -1).map(([lon, lat]) => [(lon - lon0) * east, (lat - lat0) * north])
  const count = points.length
  let signed = 0
  for (let i = 0; i < count; i++) signed += points[i][0] * points[(i + 1) % count][1] - points[(i + 1) % count][0] * points[i][1]
  // Inwards is to the left of each edge on an anticlockwise ring, to the right on a clockwise one.
  const turn = signed > 0 ? 1 : -1
  const edges = points.map((point, i) => {
    const next = points[(i + 1) % count], dx = next[0] - point[0], dy = next[1] - point[1], length = Math.hypot(dx, dy) || 1
    return { x: point[0] - dy / length * metres * turn, y: point[1] + dx / length * metres * turn, dx, dy }
  })
  const inner = edges.map((edge, i) => {
    const before = edges[(i - 1 + count) % count], cross = before.dx * edge.dy - before.dy * edge.dx
    if (Math.abs(cross) < 1e-9) return [lon0 + edge.x / east, lat0 + edge.y / north]
    const s = ((edge.x - before.x) * edge.dy - (edge.y - before.y) * edge.dx) / cross
    return [lon0 + (before.x + s * before.dx) / east, lat0 + (before.y + s * before.dy) / north]
  })
  return [...inner, inner[0]]
}

/** A fine brick-bond paving tile, repeated over walkways and squares. The pattern keeps its screen
    size at every zoom, so bricks are small enough for a 3 m walkway to show several across, with
    dark joints and bricks a shade apart to stay readable on a phone. */
function pavingImage() {
  const size = 64, canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#b5a386'
  ctx.fillRect(0, 0, size, size)
  const tones = ['#eadfc9', '#ddd0b5', '#f0e7d5']
  // Rows of 16 × 8 px bricks, every other row shifted half a brick. A brick cut at the right edge
  // carries on at the left, so tones repeat every four columns.
  for (let row = 0; row < 8; row++) for (let column = -1; column < 4; column++) {
    const x = column * 16 + (row % 2 ? 8 : 0), wrapped = (column + 4) % 4
    ctx.fillStyle = tones[(row * 2 + wrapped * (row % 3 + 1)) % tones.length]
    ctx.fillRect(x + 1, row * 8 + 1, 14.5, 6.5)
  }
  return ctx.getImageData(0, 0, size, size)
}

/** Hand-built meshes for what fill-extrusion cannot draw: pitched roofs, flagpoles and park details. */
function meshLayer(map: GLMap) {
  let solid: SolidProgram | null = null, buffer: WebGLBuffer | null = null
  let data = new Float32Array(0), dirty = false, origin: MercatorCoordinate | null = null
  const layer: CustomLayerInterface = {
    id: 'city-meshes', type: 'custom', renderingMode: '3d',
    onAdd(_map, gl) {
      solid = solidProgram(gl)
      buffer = gl.createBuffer()
      dirty = true
    },
    onRemove(_map, gl) {
      if (solid) gl.deleteProgram(solid.program)
      gl.deleteBuffer(buffer)
      solid = null
      buffer = null
    },
    render(gl, { defaultProjectionData }) {
      // Below zoom 15 the walls are still fading in, and a solid roof over them looks pasted on.
      if (!solid || !origin || !data.length || map.getZoom() < 15) return
      if (dirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
        dirty = false
      }
      const scale = origin.meterInMercatorCoordinateUnits()
      // East, north and up in metres, into mercator units whose y grows southwards.
      const model = [scale, 0, 0, 0, 0, -scale, 0, 0, 0, 0, scale, 0, origin.x, origin.y, 0, 1]
      bindSolid(gl, solid, buffer, composeMatrix(defaultProjectionData.mainMatrix, model))
      gl.drawArrays(gl.TRIANGLES, 0, data.length / 7)
      unbindSolid(gl, solid)
    },
  }

  /** Replace the whole mesh: roofs and flagpoles are few, and change only when the admin edits one. */
  function set(nextOrigin: MercatorCoordinate | null, triangles: number[]) {
    origin = nextOrigin
    data = new Float32Array(triangles)
    dirty = true
    map.triggerRepaint()
  }

  return { layer, set }
}

export function createAtlasGL(node: HTMLElement, onError?: (message: string) => void) {
  registerProtocol()

  const style: StyleSpecification = {
    version: 8,
    light: BUILDING_LIGHT,
    sources: {
      // The map zooms out to 6 and a tilted view reaches lower still towards the horizon, so tiles
      // below the coarsest stored tier (7) are gathered from it rather than left empty.
      atlas: { type: 'vector', tiles: ['atlas://{z}/{x}/{y}'], minzoom: 4, maxzoom: 13 },
      live: { type: 'geojson', data: EMPTY },
      asphalt: { type: 'geojson', data: EMPTY, maxzoom: 18 },
      walks: { type: 'geojson', data: EMPTY, maxzoom: 18 },
      crossings: { type: 'geojson', data: EMPTY, maxzoom: 18 },
      // Zoom 16 is already finer than a footprint's outline; deeper tiles would only
      // mean more of them to cut while driving.
      country: { type: 'vector', tiles: ['houses://{z}/{x}/{y}'], minzoom: 13, maxzoom: 16 },
      houses: { type: 'geojson', data: EMPTY, maxzoom: 16, tolerance: 0.05 },
      admin: { type: 'geojson', data: EMPTY, maxzoom: 16, tolerance: 0.05 },
      city: { type: 'geojson', data: EMPTY, maxzoom: 16 },
      selection: { type: 'geojson', data: EMPTY },
      routes: { type: 'geojson', data: EMPTY },
      editor: { type: 'geojson', data: EMPTY },
      points: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': BACKGROUND } },
      {
        id: 'areas', type: 'fill', source: 'atlas', 'source-layer': 'areas',
        paint: { 'fill-color': ['match', ['get', 'kind'], ...Object.entries(AREA_COLOURS).flat(), '#e5e6dc'] as never },
      },
      {
        id: 'waterways', type: 'line', source: 'atlas', 'source-layer': 'lines', filter: ['==', ['get', 'kind'], 'river'],
        paint: { 'line-color': '#8fc9df', 'line-width': ['interpolate', ['exponential', 1.26], ['zoom'], 10, 1, 16, 4] as never },
      },
      {
        id: 'rail', type: 'line', source: 'atlas', 'source-layer': 'lines', filter: ['==', ['get', 'kind'], 'rail'],
        paint: { 'line-color': '#8f9697', 'line-width': ['interpolate', ['exponential', 1.26], ['zoom'], 10, 0.8, 16, 3] as never },
      },
      {
        // Up close, walkways are drawn to scale from their own data instead of as dashes.
        id: 'paths', type: 'line', source: 'atlas', 'source-layer': 'lines', filter: ['==', ['get', 'kind'], 'path'],
        paint: { 'line-color': '#c4b9a5', 'line-dasharray': [4, 4], 'line-width': 1.2, 'line-opacity': FADE_OUT as never },
      },
      {
        id: 'borders', type: 'line', source: 'atlas', 'source-layer': 'lines', filter: ['==', ['get', 'kind'], 'border'],
        paint: { 'line-color': '#a790a9', 'line-dasharray': [4, 4], 'line-width': 1.2 },
      },
      // Walkways from OpenStreetMap, to scale: paving in the tile pattern, the rest plain or asphalt.
      // They lie under the streets, so where a path meets a street the street stays on top.
      {
        id: 'walk-surface', type: 'fill', source: 'walks', minzoom: 13, filter: ['!=', ['get', 'kind'], 'tiles'],
        paint: { 'fill-color': ['match', ['get', 'kind'], 'asphalt', '#b4b7ba', '#e6ddca'] as never, 'fill-opacity': FADE_IN as never },
      },
      {
        id: 'walk-paving', type: 'fill', source: 'walks', minzoom: 13, filter: ['==', ['get', 'kind'], 'tiles'],
        paint: { 'fill-pattern': PAVING, 'fill-opacity': FADE_IN as never },
      },
      {
        id: 'road-casing', type: 'line', source: 'atlas', 'source-layer': 'lines',
        filter: ['all', ['in', ['get', 'kind'], ['literal', ['road-local', 'road-secondary', 'road-main']]], ['!', ['has', 'asphalt']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['match', ['get', 'kind'], 'road-main', '#d8bb85', '#d9d3c8'] as never, 'line-width': roadWidth(1.5) as never },
      },
      {
        id: 'road-surface', type: 'line', source: 'atlas', 'source-layer': 'lines',
        filter: ['all', ['in', ['get', 'kind'], ['literal', ['road-local', 'road-secondary', 'road-main']]], ['!', ['has', 'asphalt']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'kind'], 'road-main', '#ffe1a1', 'road-secondary', '#fffaf0', '#ffffff'] as never,
          'line-width': roadWidth() as never,
        },
      },
      // Source asphalt and admin asphalt share these layers, so a junction between
      // them is one continuous surface rather than two overlaid ribbons.
      {
        id: 'asphalt-casing', type: 'line', source: 'atlas', 'source-layer': 'lines', filter: ['has', 'asphalt'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ASPHALT_CASING, 'line-width': asphaltWidth(true) as never, 'line-opacity': FADE_OUT as never },
      },
      {
        id: 'asphalt-casing-live', type: 'line', source: 'live', minzoom: 10,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ASPHALT_CASING, 'line-width': asphaltWidth(true) as never, 'line-opacity': FADE_OUT as never },
      },
      {
        id: 'asphalt-surface', type: 'line', source: 'atlas', 'source-layer': 'lines', filter: ['has', 'asphalt'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ASPHALT_SURFACE, 'line-width': asphaltWidth() as never, 'line-opacity': FADE_OUT as never },
      },
      {
        id: 'asphalt-surface-live', type: 'line', source: 'live', minzoom: 10,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ASPHALT_SURFACE, 'line-width': asphaltWidth() as never, 'line-opacity': FADE_OUT as never },
      },
      // Up close, asphalt to scale: kerbs under surfaces, so junctions read as one pavement, and
      // lane lines on top.
      {
        id: 'asphalt-kerb', type: 'fill', source: 'asphalt', minzoom: 13, filter: ['==', ['get', 'kind'], 'kerb'],
        paint: { 'fill-color': ASPHALT_CASING, 'fill-opacity': FADE_IN as never },
      },
      {
        id: 'asphalt-pavement', type: 'fill', source: 'asphalt', minzoom: 13, filter: ['==', ['get', 'kind'], 'surface'],
        paint: { 'fill-color': ASPHALT_SURFACE, 'fill-opacity': FADE_IN as never },
      },
      {
        id: 'asphalt-lanes', type: 'line', source: 'asphalt', minzoom: 13, filter: ['==', ['get', 'kind'], 'dash'],
        paint: { 'line-color': MARKING, 'line-width': MARK_WIDTH as never, 'line-dasharray': [5, 8], 'line-opacity': FADE_IN as never },
      },
      {
        id: 'asphalt-centre', type: 'line', source: 'asphalt', minzoom: 13, filter: ['==', ['get', 'kind'], 'centre'],
        paint: { 'line-color': MARKING, 'line-width': MARK_WIDTH as never, 'line-opacity': FADE_IN as never },
      },
      {
        id: 'asphalt-zebra', type: 'fill', source: 'crossings', minzoom: 13,
        paint: { 'fill-color': MARKING, 'fill-opacity': FADE_IN as never },
      },
      {
        id: 'buildings-flat', type: 'fill', source: 'atlas', 'source-layer': 'buildings', minzoom: 15,
        paint: { 'fill-color': '#dacfc0', 'fill-outline-color': '#c5b7a5' },
      },
      // Walkways and squares stand a hand's height above the road and lawns a little higher,
      // so a path between two lawns still reads as a path from any tilt.
      {
        id: 'city-paving', type: 'fill-extrusion', source: 'city', minzoom: HOUSE_MINZOOM, filter: ['==', ['get', 'kind'], 'tiles'],
        paint: { 'fill-extrusion-pattern': PAVING, 'fill-extrusion-height': ['get', 'height'] as never, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': HOUSE_OPACITY as never },
      },
      {
        // Lawns, asphalt, and a fountain's rim around its water.
        id: 'city-surface', type: 'fill-extrusion', source: 'city', minzoom: HOUSE_MINZOOM, filter: ['!=', ['get', 'kind'], 'tiles'],
        paint: {
          'fill-extrusion-color': ['match', ['get', 'kind'], 'plain', '#e3dac8', 'lawn', '#a8d27e', 'asphalt', '#b4b7ba', 'rim', '#b98f84', 'water', '#9ccbe9', '#e3dac8'] as never,
          'fill-extrusion-height': ['get', 'height'] as never, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': HOUSE_OPACITY as never,
        },
      },
      {
        // Houses of the rest of the country, shown once the map is close enough for them to fade in.
        id: 'country-3d', type: 'fill-extrusion', source: 'country', 'source-layer': 'houses', minzoom: HOUSE_MINZOOM,
        layout: { visibility: 'none' },
        paint: { 'fill-extrusion-color': BUILDING_COLOUR as never, 'fill-extrusion-vertical-gradient': false, 'fill-extrusion-height': ['get', 'height'] as never, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': HOUSE_OPACITY as never },
      },
      {
        id: 'houses-3d', type: 'fill-extrusion', source: 'houses', minzoom: HOUSE_MINZOOM,
        paint: { 'fill-extrusion-color': BUILDING_COLOUR as never, 'fill-extrusion-vertical-gradient': false, 'fill-extrusion-height': ['get', 'height'] as never, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': HOUSE_OPACITY as never },
      },
      {
        id: 'admin-3d', type: 'fill-extrusion', source: 'admin', minzoom: HOUSE_MINZOOM,
        paint: { 'fill-extrusion-color': BUILDING_COLOUR as never, 'fill-extrusion-vertical-gradient': false, 'fill-extrusion-height': ['get', 'height'] as never, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': HOUSE_OPACITY as never },
      },
      { id: 'selection-fill', type: 'fill', source: 'selection', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#3798db', 'fill-opacity': 0.1 } },
      {
        id: 'selection-line', type: 'line', source: 'selection',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#3a92df', 'line-width': 7, 'line-opacity': 0.55 },
      },
      { id: 'route-accuracy', type: 'fill', source: 'routes', filter: ['==', ['get', 'role'], 'accuracy'], paint: { 'fill-color': '#2785e8', 'fill-opacity': 0.08 } },
      {
        id: 'route-connector', type: 'line', source: 'routes', filter: ['==', ['get', 'role'], 'connector'],
        paint: { 'line-color': '#7c8b81', 'line-width': 3, 'line-dasharray': [4, 7] },
      },
      {
        id: 'route-alt', type: 'line', source: 'routes', filter: ['==', ['get', 'role'], 'alternative'],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#a6bbd7', 'line-width': 7 },
      },
      {
        id: 'route-outline', type: 'line', source: 'routes', filter: ['in', ['get', 'role'], ['literal', ['active', 'remaining']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 11 },
      },
      {
        id: 'route-active', type: 'line', source: 'routes', filter: ['==', ['get', 'role'], 'active'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#12ad50', 'line-width': 7 },
      },
      {
        id: 'route-remaining', type: 'line', source: 'routes', filter: ['==', ['get', 'role'], 'remaining'],
        layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#12ad50', 'line-width': 7 },
      },
      {
        id: 'editor-fill', type: 'fill', source: 'editor', filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': ['match', ['get', 'role'], 'district', '#528b79', '#d8c8b1'] as never,
          'fill-opacity': ['match', ['get', 'role'], 'district', 0.06, 0.55] as never,
        },
      },
      {
        id: 'editor-line', type: 'line', source: 'editor', filter: ['!=', ['geometry-type'], 'Point'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'role'], 'district', '#528b79', '#887560'] as never,
          'line-width': 1.5,
          'line-dasharray': ['match', ['get', 'role'], 'district', ['literal', [6, 6]], ['literal', [1, 0]]] as never,
        },
      },
      {
        id: 'editor-point', type: 'circle', source: 'editor', filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': ['case', ['get', 'published'], '#00866a', '#9b7a30'] as never,
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3,
        },
      },
      {
        // Places: grey discs with a white pictogram, drawn on demand by styleimagemissing. Far out
        // only the important ones show; where discs crowd, the lower rank keeps its place.
        id: 'points', type: 'symbol', source: 'points', minzoom: POI_MINZOOM, filter: POI_RANK_FILTER as never,
        layout: {
          'icon-image': ['get', 'icon'] as never, 'icon-size': poiIconSizeExpression() as never, 'icon-anchor': 'center',
          'icon-allow-overlap': false, 'icon-ignore-placement': false, 'icon-padding': 1,
          'symbol-sort-key': ['get', 'rank'] as never, 'symbol-z-order': 'auto',
          'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
        },
        // The place under the destination pin keeps its room but hands its look to the pin.
        paint: { 'icon-opacity': ['case', ['boolean', ['get', 'focus'], false], 0, 1] as never },
      },
    ],
  }

  const map = new GLMap({
    container: node,
    style,
    center: [70.3597068, 40.6601966],
    zoom: 15,
    minZoom: 6,
    maxZoom: 19,
    maxBounds: [[66.3, 35.8], [76.1, 41.9]],
    attributionControl: false,
    maxPitch: 70,
  })
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right')
  // The compass needle follows the map, so a rotated view is never a surprise.
  const showBearing = () => document.documentElement.style.setProperty('--atlas-bearing', String(-map.getBearing()))
  map.on('rotate', showBearing)
  showBearing()
  map.touchZoomRotate.enable({ around: 'center' })
  map.touchPitch.enable()
  map.on('error', event => { onError?.(event.error?.message || 'Не удалось отрисовать карту') })
  // The paving pattern and the place discs are drawn here rather than shipped in a sprite the offline map would need.
  map.on('styleimagemissing', event => {
    if (addPoiImage(map, event.id)) return
    if (event.id !== PAVING || map.hasImage(PAVING)) return
    const image = pavingImage()
    if (image) map.addImage(PAVING, image, { pixelRatio: 2 })
  })

  // Houses are fully faded out below zoom 14, so the country's house files wait until then.
  const showCountryHouses = () => {
    if (!map.getLayer('country-3d')) return
    const visibility = map.getZoom() >= 14 ? 'visible' : 'none'
    if (map.getLayoutProperty('country-3d', 'visibility') !== visibility) map.setLayoutProperty('country-3d', 'visibility', visibility)
  }
  for (const event of ['load', 'zoom'] as const) map.on(event, showCountryHouses)

  const ready = loadTileIndex()
  const meshes = meshLayer(map)
  const arrow = locationArrow(map)
  // Close-up facades, grey roofs, parapets, rooftop boxes and street trees (lib/detail-layer.ts).
  let houseFeatures: HouseFeature[] = [], adminDrawn: AdminBuilding[] = []
  const detail = detailLayer(map, {
    houseList: loadHouseList, houseFile, approximateHeight: APPROXIMATE_HEIGHT,
    local: () => [
      ...houseFeatures.map(feature => ({
        id: feature.properties.key, ring: feature.geometry.coordinates[0], height: feature.properties.height,
        roof: heightInfo[feature.properties.key]?.roof ?? null,
      })),
      ...adminDrawn.map(building => ({
        id: `admin:${building.id}`, ring: building.geometry.coordinates[0], height: wallHeight(building),
        roof: building.roof ?? null, holes: building.geometry.coordinates.length > 1,
      })),
    ],
    roads: () => {
      const edited = new Set(adminRoads.map(road => road.id))
      return adminRoads.concat([...osmRoads.values()].filter(road => !edited.has(road.id)))
    },
    trees: () => osmThings.filter(thing => thing.kind === 'tree').map(thing => thing.point),
  })

  // Sources only exist once the style is parsed, and the style can settle late.
  // Hold the newest payload per source and keep trying until it is accepted.
  const waiting = new Map<string, unknown>()
  const filters = new Map<string, unknown>()
  function flush() {
    if (!map.getLayer(detail.layer.id)) {
      try { map.addLayer(detail.layer, map.getLayer('selection-fill') ? 'selection-fill' : undefined) } catch { /* the style is still being parsed */ }
    }
    // Roofs and flagpoles first, so the arrow stays the last thing drawn.
    for (const custom of [meshes.layer, arrow.layer]) {
      if (map.getLayer(custom.id)) continue
      // 3D meshes go under the place discs; the arrow stays on top of everything.
      const before = custom !== arrow.layer && map.getLayer('points') ? 'points' : undefined
      try { map.addLayer(custom, before) } catch { /* the style is still being parsed */ }
    }
    for (const [id, data] of [...waiting]) {
      const target = map.getSource(id) as GeoJSONSource | undefined
      if (!target) continue
      target.setData(data as never)
      waiting.delete(id)
    }
    for (const [id, filter] of [...filters]) {
      if (!map.getLayer(id)) continue
      map.setFilter(id, filter as never)
      filters.delete(id)
    }
  }
  const push = (id: string, data: unknown) => { waiting.set(id, data); flush() }
  const filter = (id: string, value: unknown) => { filters.set(id, value); flush() }
  for (const event of ['styledata', 'load', 'idle', 'sourcedata'] as const) map.on(event, flush)

  // --- text overlay -------------------------------------------------------
  const text = document.createElement('canvas')
  text.className = 'atlas-labels'
  Object.assign(text.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '3' })
  node.appendChild(text)

  let labels: AtlasLabel[] = []
  let houseLabels: AtlasLabel[] = []
  let placeLabels: AtlasLabel[] = []
  let boxes: { box: number[]; label: AtlasLabel }[] = []
  // Place names follow the discs MapLibre kept: a disc hidden by collision takes its name with it.
  const placed = poiPlacement(map, 'points')

  function drawLabels() {
    const size = map.getCanvas().getBoundingClientRect()
    const dpr = Math.min(devicePixelRatio || 1, 2)
    if (text.width !== Math.round(size.width * dpr) || text.height !== Math.round(size.height * dpr)) {
      text.width = Math.round(size.width * dpr)
      text.height = Math.round(size.height * dpr)
      text.style.width = size.width + 'px'
      text.style.height = size.height + 'px'
    }
    const ctx = text.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)
    const zoom = map.getZoom()
    placed.refresh()
    const bounds = map.getBounds()
    const west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth()
    // With the camera tilted, everything above the horizon is distant clutter.
    const floor = map.getPitch() > 25 ? size.height * (map.getPitch() - 25) / 90 : 0
    const occupied: number[][] = []
    boxes = []
    // Every disc on screen keeps lesser labels off it; a place is named only while its disc shows.
    const iconBoxes = poiIconBoxes(map, placeLabels, placed, zoom, size)
    let iconsBlocked = false
    const candidates = labels
      .concat(zoom >= 15 ? placeLabels.filter(label => placed.has(label.owner)) : [])
      .concat(zoom >= 16 ? stopLabels : [])
      .concat(zoom >= 17 ? houseLabels : [])
    const ordered = candidates.slice().sort((a, b) => (LABEL_RANK[a.kind] ?? 9) - (LABEL_RANK[b.kind] ?? 9) || (a.priority ?? 0) - (b.priority ?? 0))
    for (const label of ordered) {
      // Country, city, town and neighbourhood names stay above the discs; the rest give way to them.
      if (!iconsBlocked && (LABEL_RANK[label.kind] ?? 9) >= LABEL_RANK.place) {
        for (const box of iconBoxes) occupied.push(box)
        iconsBlocked = true
      }
      if (zoom < label.minzoom || (label.maxzoom !== null && zoom > label.maxzoom)) continue
      if (label.kind === 'road' && zoom < 14) continue
      if (label.kind === 'country' && zoom > 9) continue
      if (label.lon < west || label.lon > east || label.lat < south || label.lat > north) continue
      const point = map.project([label.lon, label.lat])
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
      point.y += label.kind === 'place' ? poiLabelOffset(zoom) : label.offset ?? 0
      if (point.x < 25 || point.y < floor + 12 || point.x > size.width - 25 || point.y > size.height - 12) continue
      const font = label.kind === 'country' ? 20 : label.kind === 'city' ? (zoom < 10 ? 16 : 19)
        : label.kind === 'town' ? 15 : label.kind === 'house' ? 11 : label.kind === 'road' ? 12 : 13
      ctx.font = `${label.kind === 'road' || label.kind === 'house' ? '400' : '600'} ${font}px Arial`
      // A long place name is cut short; its box starts at the text, so its own disc never blocks it.
      const caption = label.kind === 'place' && label.name.length > 28 ? label.name.slice(0, 27).trimEnd() + '…' : label.name
      const width = ctx.measureText(caption).width + 12, height = font + (label.kind === 'place' ? 2 : 8)
      const box = [point.x - width / 2, point.y - height / 2, point.x + width / 2, point.y + height / 2]
      if (occupied.some(other => other[0] < box[2] && other[2] > box[0] && other[1] < box[3] && other[3] > box[1])) continue
      occupied.push(box)
      boxes.push({ box, label })
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 3.5
      ctx.strokeStyle = '#ffffffeb'
      ctx.strokeText(caption, point.x, point.y)
      ctx.fillStyle = label.kind === 'house' ? '#94836a' : label.kind === 'road' ? '#7a7467'
        : label.kind === 'place' ? POI_COLOURS.label : '#4e6254'
      ctx.fillText(caption, point.x, point.y)
    }
  }
  map.on('render', drawLabels)
  // Discs settle after the last frame of a move: name exactly the ones that stayed.
  // (drawLabels directly: a repaint here would only bring another idle.)
  map.on('idle', () => { if (placed.refresh(true)) drawLabels() })

  /** The label sits on top of whatever it names, so the label wins the tap. */
  function labelAt(x: number, y: number, pad = 7): LabelHit | null {
    let best: LabelHit | null = null, closest = Infinity
    for (const { box, label } of boxes) {
      if (x < box[0] - pad || x > box[2] + pad || y < box[1] - pad || y > box[3] + pad) continue
      const gap = Math.hypot(x - (box[0] + box[2]) / 2, y - (box[1] + box[3]) / 2)
      if (gap < closest) { closest = gap; best = { name: label.name, kind: label.kind, owner: label.owner, lat: label.lat, lon: label.lon } }
    }
    return best
  }

  /** GPS accuracy drawn on the ground, so it keeps its size as the map tilts. */
  function circle([lon, lat]: [number, number], metres: number, steps = 48) {
    const latitude = metres / 111_320, longitude = latitude / Math.max(1e-6, Math.cos(lat * Math.PI / 180))
    const ring: number[][] = []
    for (let i = 0; i <= steps; i++) {
      const angle = i / steps * Math.PI * 2
      ring.push([lon + Math.cos(angle) * longitude, lat + Math.sin(angle) * latitude])
    }
    return ring
  }
  const lineFeature = (coordinates: number[][], properties: Record<string, unknown> = {}) =>
    ({ type: 'Feature' as const, properties, geometry: { type: 'LineString' as const, coordinates } })
  const areaFeature = (coordinates: number[][][], kind: string) =>
    ({ type: 'Feature' as const, properties: { kind }, geometry: { type: 'Polygon' as const, coordinates } })

  /* Streets whose lanes are known, so the route and the arrow keep to a lane on them. */
  let laneIndex = laneSegments([])
  let lastRoutes: RouteLines | null = null

  /* How the trip is made decides where on the street the route and the arrow keep: drivers in the
     rightmost lane, cyclists near the kerb, pedestrians on the pavement. */
  let travelMode: Mode = 'car'
  const keep = (spot: LaneSpot | null) => spot ? keepRight(travelMode, spot.shift, spot.half) : 0
  function setTravelMode(mode: Mode) {
    travelMode = mode
    if (lastRoutes) setRoutes(lastRoutes)
  }

  /** The arrow keeps to its place too. A GPS fix wanders off the centre line, so it looks a little wider. */
  function setLocationArrow(next: ArrowPosition | null) {
    if (!next) { arrow.set(null); return }
    arrow.set({ ...next, lane: keep(laneAt(laneIndex, next.lon, next.lat, next.heading ?? arrow.heading(), 10)) })
  }

  /* OpenStreetMap's asphalt streets, loaded tile by tile near where the map looks. The admin's own
     streets override them way by way, and both are drawn in the live layers. */
  const osmRoads = new Map<string, LiveRoad>(), roadFiles = new Set<string>()
  let adminRoads: LiveRoad[] = []

  function showRoads() {
    const edited = new Set(adminRoads.map(road => road.id))
    const roads = adminRoads.concat([...osmRoads.values()].filter(road => !edited.has(road.id)))
    push('live', { type: 'FeatureCollection', features: roads.map(road => lineFeature(road.coordinates, { id: road.id })) })
    // Up close the asphalt is drawn to scale: a kerb and a surface outline, and lane lines on top.
    // Where streets meet, an end is rounded no wider than the widest street it meets, so a broad
    // avenue does not bulge past a narrower crossing, and lane lines stop short of the crossing.
    const halves = roads.map(road => carriagewayMetres(road.asphalt, !!road.oneway) / 2)
    const key = (point: number[]) => `${point[0].toFixed(6)},${point[1].toFixed(6)}`
    const through = new Map<string, number[]>()
    roads.forEach((road, index) => {
      for (const point of new Set(road.coordinates.map(key))) {
        const list = through.get(point)
        if (list) list.push(index)
        else through.set(point, [index])
      }
    })
    const kerbs: unknown[] = [], surfaces: unknown[] = [], marks: unknown[] = []
    roads.forEach((road, index) => {
      const half = halves[index], line = road.coordinates
      const crossing = (point: number[]) => (through.get(key(point)) ?? []).reduce((widest, other) => other === index ? widest : Math.max(widest, halves[other]), 0)
      const cap = (point: number[]) => { const other = crossing(point); return other ? Math.min(half, other) : half }
      const caps = [cap(line[0]), cap(line[line.length - 1])]
      for (const polygon of ribbon(line, half * 2 + 0.6, [caps[0] + 0.3, caps[1] + 0.3])) kerbs.push(areaFeature(polygon, 'kerb'))
      for (const polygon of ribbon(line, half * 2, caps)) surfaces.push(areaFeature(polygon, 'surface'))
      for (const mark of laneLines(road, crossing)) marks.push(lineFeature(mark.coordinates, { kind: mark.kind }))
    })
    push('asphalt', { type: 'FeatureCollection', features: kerbs.concat(surfaces, marks) })
    laneIndex = laneSegments(roads)
    showCrossings()
    if (lastRoutes) setRoutes(lastRoutes)
    detail.invalidate()
  }

  /** The files of a zoom-10 folder around the middle of the map that are not fetched yet, fetched. */
  async function nearbyFiles<T>(folder: string, fetched: Set<string>): Promise<T[]> {
    if (map.getZoom() < ROAD_TIER) return []
    const names = await loadTileList(folder).catch(() => null)
    if (!names) return []
    const n = 2 ** ROAD_TIER, centre = map.getCenter(), bounds = map.getBounds()
    const column = (lon: number) => Math.floor((lon + 180) / 360 * n)
    const row = (lat: number) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n)
    // A steep view reaches the horizon, so stay within two tiles of the middle.
    const cx = column(centre.lng), cy = row(centre.lat), wanted: string[] = []
    for (let x = Math.max(cx - 2, column(bounds.getWest())); x <= Math.min(cx + 2, column(bounds.getEast())); x++) {
      for (let y = Math.max(cy - 2, row(bounds.getNorth())); y <= Math.min(cy + 2, row(bounds.getSouth())); y++) {
        const name = `${x}-${y}`
        if (names.has(name) && !fetched.has(name)) { fetched.add(name); wanted.push(name) }
      }
    }
    const files = await Promise.all(wanted.map(name => fetch(siteUrl(`/${folder}/${name}.json`))
      .then(response => response.ok ? response.json() as Promise<T> : null).catch(() => null)
      // Offline for now: try this file again next time the map settles.
      .then(file => { if (!file) fetched.delete(name); return file })))
    return files.filter((file): file is Awaited<T> & T => file !== null)
  }

  async function loadNearbyRoads() {
    const files = await nearbyFiles<{ roads: number[][] }>('atlas-roads', roadFiles)
    if (!files.length) return
    for (const file of files) for (const [way, lanes, oneway, ...steps] of file.roads) {
      const coordinates: number[][] = []
      let x = 0, y = 0
      for (let i = 0; i + 1 < steps.length; i += 2) { x += steps[i]; y += steps[i + 1]; coordinates.push([x / 1e6, y / 1e6]) }
      osmRoads.set(`way/${way}`, { id: `way/${way}`, asphalt: lanes, oneway: oneway === 1, coordinates })
    }
    showRoads()
  }

  async function loadNearbyThings() {
    const files = await nearbyFiles<{ things: (string | number)[][] }>('atlas-things', thingFiles)
    if (!files.length) return
    for (const file of files) for (const [kind, lon, lat, facing, size, name] of file.things) {
      osmThings.push({ kind: String(kind), point: [Number(lon) / 1e6, Number(lat) / 1e6], facing: Number(facing), size: Number(size) / 10, name: typeof name === 'string' ? name : '' })
    }
    stopLabels = osmThings.filter(thing => thing.kind === 'stop' && thing.name)
      .map(thing => ({ lon: thing.point[0], lat: thing.point[1], name: thing.name, kind: 'place', minzoom: 16, maxzoom: null, offset: -22 }))
    showMeshes()
    detail.invalidate()
  }
  /* Walkways from OpenStreetMap: strips to scale along footways, paths and tracks, and footway areas.
     Crossings, as ways over a street or points on one, become zebras on the asphalt. */
  const walkFeatures: unknown[] = [], walkFiles = new Set<string>(), walkSeen = new Set<string>()
  const crossingPoints: number[][] = [], crossingLines: number[][][] = []
  async function loadNearbyWalks() {
    const files = await nearbyFiles<{ walks: number[][] }>('atlas-walks', walkFiles)
    if (!files.length) return
    const kinds = ['plain', 'tiles', 'asphalt']
    for (const file of files) for (const [shape, surface, width, ...steps] of file.walks) {
      // A walkway reaching two files arrives twice.
      const id = `${shape}:${steps.length}:${steps.slice(0, 4).join(',')}`
      if (walkSeen.has(id)) continue
      walkSeen.add(id)
      const coordinates: number[][] = []
      let x = 0, y = 0
      for (let i = 0; i + 1 < steps.length; i += 2) { x += steps[i]; y += steps[i + 1]; coordinates.push([x / 1e6, y / 1e6]) }
      const kind = kinds[surface] ?? 'plain'
      if (shape === 4) crossingPoints.push(coordinates[0])
      else if (shape === 2) crossingLines.push(coordinates)
      else if (shape === 1) walkFeatures.push(areaFeature([coordinates], kind))
      else {
        for (const polygon of ribbon(coordinates, width / 10)) walkFeatures.push(areaFeature(polygon, kind))
        // A footway that runs across a street crosses it, tagged as a crossing or not; a field track does not.
        if (shape === 0) crossingLines.push(coordinates)
      }
    }
    push('walks', { type: 'FeatureCollection', features: walkFeatures })
    showCrossings()
  }

  /** A zebra wherever a walkway crosses an asphalt street or a crossing is mapped on one, one to a spot. */
  function showCrossings() {
    type Spot = { point: number[]; bearing: number; half: number }
    const spots: Spot[] = []
    const add = (spot: Spot) => {
      const cos = Math.cos(spot.point[1] * Math.PI / 180)
      if (!spots.some(other => Math.hypot((other.point[0] - spot.point[0]) * cos, other.point[1] - spot.point[1]) * 111_320 < 8)) spots.push(spot)
    }
    for (const point of crossingPoints) {
      const street = streetAt(laneIndex, point[0], point[1], 3)
      if (street) add({ point, ...street })
    }
    for (const line of crossingLines) for (const spot of streetCrossings(laneIndex, line)) add(spot)
    push('crossings', { type: 'FeatureCollection', features: spots.flatMap(spot => zebra(spot.point, spot.bearing, spot.half).map(polygon => areaFeature(polygon, 'zebra'))) })
  }
  for (const event of ['load', 'moveend'] as const) map.on(event, () => { void loadNearbyRoads(); void loadNearbyThings(); void loadNearbyWalks() })

  /** Admin road styling, as GeoJSON so it stays in the same layers as R-303. */
  function setLiveRoads(roads: LiveRoad[]) {
    adminRoads = roads
    showRoads()
    const suppressed = roads.map(road => Number(road.id.replace(/^\D+/, ''))).filter(Number.isFinite)
    for (const layer of ['asphalt-casing', 'asphalt-surface']) {
      filter(layer, ['all', ['has', 'asphalt'], ['!', ['in', ['get', 'way'], ['literal', suppressed]]]])
    }
  }

  function decode(data: BuildingData) {
    const [originLon, originLat] = data.origin, scale = data.scale
    return data.buildings.map((flat, index) => {
      const ring: number[][] = []
      let x = 0, y = 0, sumX = 0, sumY = 0
      for (let i = 0; i < flat.length; i += 2) {
        x += flat[i]; y += flat[i + 1]
        const lon = originLon + x / scale, lat = originLat + y / scale
        ring.push([lon, lat]); sumX += lon; sumY += lat
      }
      ring.push(ring[0])
      const points = ring.length - 1
      return { ring, centre: [sumX / points, sumY / points] as [number, number], index }
    })
  }

  let houseData: BuildingData | null = null, houseShapes: ReturnType<typeof decode> = []
  let osmHouses: OsmBuilding[] = [], heightInfo: Record<string, HeightInfo> = {}
  let houseRoofs: Roof[] = [], adminRoofs: Roof[] = [], details: Detail[] = [], fountains: Fountain[] = []
  /** Every Shaydon footprint and admin building by key, with its whole outline, for the tap (building-pick.ts). */
  let houseByKey = new Map<string, BuildingRecord>(), adminByKey = new Map<string, BuildingRecord>()

  /* Street furniture from OpenStreetMap, loaded file by file. Only what stands near the middle of
     the map becomes mesh, and the mesh follows the map once it has moved half a kilometre. */
  const osmThings: Thing[] = [], thingFiles = new Set<string>()
  let meshCentre: [number, number] | null = null, stopLabels: AtlasLabel[] = []

  function nearbyThings() {
    const centre = map.getCenter(), cos = Math.cos(centre.lat * Math.PI / 180)
    meshCentre = [centre.lng, centre.lat]
    const near = osmThings.map(thing => ({ thing, gap: Math.hypot((thing.point[0] - centre.lng) * cos, thing.point[1] - centre.lat) * 111_320 }))
      .filter(({ thing, gap }) => gap < (thing.kind === 'tree' ? 1200 : 3000))
      .sort((a, b) => a.gap - b.gap)
    // Trees are the heaviest model, so a phone draws only the nearest of them.
    let trees = 0
    return near.filter(({ thing }) => thing.kind !== 'tree' || ++trees <= 1200).slice(0, 2500).map(({ thing }) => thing)
  }
  map.on('moveend', () => {
    if (!osmThings.length || !meshCentre) return
    const centre = map.getCenter()
    if (Math.hypot((centre.lng - meshCentre[0]) * Math.cos(centre.lat * Math.PI / 180), centre.lat - meshCentre[1]) * 111_320 > 500) showMeshes()
  })

  /** Roofs, flagpoles, park details, fountain jets and street furniture share one mesh, measured from the first thing in it. */
  function showMeshes() {
    const roofs = [...houseRoofs, ...adminRoofs], things = nearbyThings()
    const first = roofs[0]?.ring[0] ?? details[0]?.point ?? fountains[0]?.centre ?? things[0]?.point
    const origin = first ? MercatorCoordinate.fromLngLat([first[0], first[1]]) : null
    const triangles: number[] = []
    if (origin) {
      for (const roof of roofs) {
        const box = rectangleAround(localMetres(roof.ring, origin))
        if (box && box.fill >= ROOF_FILL) roofTriangles(box, roof.shape, roof.base, triangles)
      }
      for (const detail of details) {
        const [[x, y]] = localMetres([detail.point], origin)
        detailTriangles(detail, x, y, triangles)
      }
      for (const fountain of fountains) {
        // A tall jet in the middle and a ring of lower ones in from each corner of the basin.
        const [centre, ...corners] = localMetres([fountain.centre, ...fountain.corners], origin)
        jetTriangles(centre[0], centre[1], 2, triangles)
        for (const [cx, cy] of corners) jetTriangles(cx + (centre[0] - cx) * 0.35, cy + (centre[1] - cy) * 0.35, 1, triangles)
      }
      for (const thing of things) {
        const [[x, y]] = localMetres([thing.point], origin)
        thingTriangles(thing, x, y, triangles)
      }
    }
    meshes.set(origin, triangles)
  }
  type HouseFeature = {
    type: 'Feature'; geometry: { type: 'Polygon'; coordinates: number[][][] }
    properties: { key: string; height: number; house: number; street: string; label: string; tone: number }
  }

  /** Microsoft footprints and Shaydon's OSM buildings share one 3D layer. Each carries
      the key its floors are stored under, so the admin panel can find it again. */
  function pushHouses() {
    const features: HouseFeature[] = houseShapes.map(shape => {
      const key = `ms:${shape.index}`, streetIndex = houseData?.street?.[shape.index] ?? -1
      return {
        type: 'Feature', geometry: { type: 'Polygon', coordinates: [shape.ring] },
        properties: {
          key, height: wallHeight(heightInfo[key]), label: '', tone: houseTone(key),
          house: houseData?.number?.[shape.index] ?? 0,
          street: streetIndex >= 0 ? houseData?.streets?.[streetIndex] ?? '' : '',
        },
      }
    })
    for (const building of osmHouses) {
      const key = `osm:${building.id}`
      features.push({
        type: 'Feature', geometry: { type: 'Polygon', coordinates: [building.ring] },
        properties: { key, height: wallHeight(heightInfo[key] ?? building), house: 0, street: '', label: building.name ?? '', tone: houseTone(key) },
      })
    }
    push('houses', { type: 'FeatureCollection', features })
    houseFeatures = features
    const osmByKey = new Map(osmHouses.map(building => [`osm:${building.id}`, building]))
    houseByKey = new Map(features.map(({ geometry, properties }): [string, BuildingRecord] => {
      // The same source wallHeight() drew the walls from: the admin's floors, else OpenStreetMap's.
      const info = heightInfo[properties.key] ?? osmByKey.get(properties.key)
      return [properties.key, {
        key: properties.key, source: 'houses', ring: geometry.coordinates[0], height: properties.height,
        number: properties.house, street: properties.street, label: properties.label,
        ...(heightStated({ levels: info?.levels }) ? { levels: info?.levels } : {}), stated: heightStated(info),
      }]
    }))
    // Only a roof the admin chose is drawn, on walls as tall as the feature says.
    houseRoofs = features.flatMap(feature => {
      const roof = heightInfo[feature.properties.key]?.roof
      return roof ? [{ key: feature.properties.key, ring: feature.geometry.coordinates[0], shape: roof, base: feature.properties.height }] : []
    })
    showMeshes()
    detail.invalidate()
  }

  function setBuildings(data: BuildingData | null) {
    houseData = data?.buildings?.length ? data : null
    houseShapes = houseData ? decode(houseData) : []
    pushHouses()
    if (!data?.buildings?.length) { houseLabels = []; return }
    houseLabels = houseShapes.flatMap(shape => {
      const number = data.number?.[shape.index]
      if (!number) return []
      const streetIndex = data.street?.[shape.index] ?? -1
      const street = streetIndex >= 0 ? data.streets?.[streetIndex] : undefined
      return [{
        lon: shape.centre[0], lat: shape.centre[1], name: String(number), kind: 'house',
        minzoom: 17, maxzoom: null, owner: street ? `house:${street}:${number}` : undefined,
      }]
    })
  }

  function setOsmBuildings(buildings: OsmBuilding[]) {
    osmHouses = buildings.filter(building => Array.isArray(building.ring) && building.ring.length >= 4)
    pushHouses()
  }

  /** Floors and heights the admin has given shipped footprints, by key. */
  function setBuildingInfo(info: Record<string, HeightInfo>) {
    heightInfo = info
    pushHouses()
  }

  /** The outline of a shipped footprint, so the editor can frame it. */
  function houseRing(key: string): number[][] | null {
    if (key.startsWith('ms:')) return houseShapes[Number(key.slice(3))]?.ring ?? null
    return osmHouses.find(building => `osm:${building.id}` === key)?.ring ?? null
  }

  /** Landscaping from the admin: paving, lawns and fountain basins as low extrusions; flagpoles,
      park details and fountain jets as meshes. The feature kind here is what to paint. */
  function setCityObjects(objects: CityShape[]) {
    type CityFeature = { type: 'Feature'; properties: { id: string; kind: string; height: number }; geometry: { type: 'Polygon'; coordinates: number[][][] } }
    const features: CityFeature[] = []
    const add = (id: string, kind: string, height: number, coordinates: number[][][]) =>
      features.push({ type: 'Feature', properties: { id, kind, height }, geometry: { type: 'Polygon', coordinates } })
    details = []
    fountains = []
    for (const object of objects) {
      if (isDetail(object)) {
        const { kind, width, height, length, thickness, rotation } = object
        if (object.geometry.coordinates.length === 2) details.push({ kind, point: object.geometry.coordinates, width, height, length, thickness, rotation })
        continue
      }
      const surface = object.surface === 'asphalt' || object.surface === 'plain' ? object.surface : 'tiles'
      if (object.geometry.type === 'LineString') {
        // Walkways, and squares or lawns drawn as a strip along a line.
        if (object.geometry.coordinates.length < 2) continue
        const paint = object.kind === 'lawn' ? 'lawn' : surface, height = object.kind === 'lawn' ? 0.35 : object.kind === 'path' ? 0.12 : 0.08
        for (const polygon of walkway(object.geometry.coordinates, object.width ?? 3)) add(object.id, paint, height, polygon)
        continue
      }
      const ring = object.geometry.coordinates[0]
      if (!ring || ring.length < 4) continue
      if (object.kind === 'fountain') {
        // The rim is the outline with the water cut out of it, so the basin reads as a basin.
        const inner = insetRing(ring, 0.35), corners = inner.slice(0, -1)
        add(object.id, 'rim', 0.55, [ring, [...inner].reverse()])
        add(object.id, 'water', 0.32, [inner])
        const centre = corners.reduce((sum, [lon, lat]) => [sum[0] + lon / corners.length, sum[1] + lat / corners.length], [0, 0])
        fountains.push({ centre, corners })
      } else add(object.id, object.kind === 'lawn' ? 'lawn' : surface, object.kind === 'lawn' ? 0.35 : 0.08, object.geometry.coordinates)
    }
    push('city', { type: 'FeatureCollection', features })
    showMeshes()
  }

  /** Admin-drawn buildings, kept apart from the surveyed footprints. */
  function setAdminBuildings(buildings: AdminBuilding[]) {
    const drawn = buildings.filter(building => building.geometry?.coordinates?.length)
    push('admin', {
      type: 'FeatureCollection',
      features: drawn.map(building => ({
        type: 'Feature' as const,
        properties: { height: wallHeight(building), id: building.id, key: `admin:${building.id}`, label: building.name ?? '', tone: houseTone(`admin:${building.id}`) },
        geometry: { type: 'Polygon' as const, coordinates: building.geometry.coordinates },
      })),
    })
    adminByKey = new Map(drawn.map((building): [string, BuildingRecord] => {
      const key = `admin:${building.id}`, [ring, ...holes] = building.geometry.coordinates
      return [key, {
        key, source: 'admin', ring, ...(holes.length ? { holes } : {}), height: wallHeight(building), label: building.name ?? '',
        ...(heightStated({ levels: building.levels }) ? { levels: building.levels } : {}), stated: heightStated(building),
      }]
    }))
    adminRoofs = drawn.flatMap(building => building.roof
      ? [{ key: `admin:${building.id}`, ring: building.geometry.coordinates[0], shape: building.roof, base: wallHeight(building) }] : [])
    showMeshes()
    adminDrawn = drawn
    detail.invalidate()
  }

  function setLabels(next: AtlasLabel[]) { labels = next; map.triggerRepaint() }

  let lastPoints: MapPoint[] = [], focusId: string | null = null
  function setPoints(points: MapPoint[]) {
    detail.addPlaces(points)
    lastPoints = points
    // The focused place (under the destination pin) goes first, for its disc's room and its name.
    const rankOf = (point: MapPoint) => point.id === focusId ? -1 : point.rank ?? 3
    placeLabels = points.map(point => ({
      lon: point.lon, lat: point.lat, name: point.name, kind: 'place',
      minzoom: 15, maxzoom: null, owner: point.id, priority: rankOf(point),
    }))
    push('points', {
      type: 'FeatureCollection',
      features: points.map(point => ({
        type: 'Feature' as const,
        properties: {
          id: point.id, name: point.name, category: point.category,
          icon: POI_IMAGE_PREFIX + (point.icon || 'map-pin'), rank: rankOf(point), focus: point.id === focusId,
        },
        geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] },
      })),
    })
    placed.stale()
  }

  /** The place under the destination pin: its disc turns invisible but keeps its room, and its name goes first. */
  function setPointFocus(id: string | null) {
    if (id === focusId) return
    focusId = id
    setPoints(lastPoints)
  }

  function setSelection(geometry: SelectionGeometry | null) {
    push('selection', geometry ? { type: 'Feature', properties: {}, geometry } : EMPTY)
  }

  function setRoutes(routes: RouteLines | null) {
    lastRoutes = routes
    if (!routes) { push('routes', EMPTY); return }
    type RouteFeature = {
      type: 'Feature'
      properties: Record<string, unknown>
      geometry: { type: 'LineString'; coordinates: number[][] } | { type: 'Polygon'; coordinates: number[][][] }
    }
    // While driving only the road ahead is drawn: the stretch already covered is gone.
    const drawn = routes.running ? [] : routes.variants
    // Each stretch keeps to its place on the street it runs along: a lane, the kerb or the pavement.
    const laned = (path: number[][], properties: Record<string, unknown>) =>
      lanePieces(laneIndex, path, keep).map(piece => lineFeature(offsetLine(piece.coordinates, piece.shift), properties))
    const features: RouteFeature[] = drawn.flatMap((path, index) =>
      laned(path, { role: index === routes.active ? 'active' : 'alternative', index }))
    if (routes.connector) features.push(lineFeature(routes.connector, { role: 'connector' }))
    if (routes.remaining) features.push(...laned(routes.remaining, { role: 'remaining' }))
    if (routes.accuracy && routes.accuracy.radius > 0) features.push({
      type: 'Feature' as const, properties: { role: 'accuracy' },
      geometry: { type: 'Polygon' as const, coordinates: [circle(routes.accuracy.centre, routes.accuracy.radius)] },
    })
    push('routes', { type: 'FeatureCollection', features })
  }

  const rendered = (point: MapMouseEvent['point'], ids: string[], pad = 0) => {
    const layers = ids.filter(id => map.getLayer(id))
    if (!layers.length) return []
    const box: [[number, number], [number, number]] = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]]
    return map.queryRenderedFeatures(pad ? box : point, { layers })
  }

  /* Buildings as a tap sees them: the extrusion layers MapLibre can query, the app's own whole outlines for
     them (GeoJSON tiles cut outlines at tile edges), and the meshes MapLibre cannot query. */
  const buildings: BuildingCatalogue = {
    layers: ['admin-3d', 'houses-3d', 'country-3d'],
    known: key => houseByKey.get(key) ?? adminByKey.get(key),
    solids: () => {
      const solids: BuildingSolid[] = []
      for (const roof of houseRoofs) { const record = roof.key ? houseByKey.get(roof.key) : undefined; if (record) solids.push({ record, roof: roof.shape, base: roof.base }) }
      for (const roof of adminRoofs) { const record = roof.key ? adminByKey.get(roof.key) : undefined; if (record) solids.push({ record, roof: roof.shape, base: roof.base }) }
      return solids
    },
  }

  /** The building under a screen point as the camera sees it: front-most along the line of sight, with its
      whole outline and its middle. The admin panel asks at any zoom the houses are drawn at. */
  function houseAt(point: { x: number; y: number }) {
    return pickBuilding(map, point, buildings)
  }

  /** What the tap landed on: a marker, a name, a building, or bare ground. */
  function pick(event: MapMouseEvent) {
    const marks = rendered(event.point, ['points'], 10)
    if (marks.length) return { kind: 'point' as const, id: String(marks[0].properties?.id ?? '') }
    // Far out, a place name is a bigger target than the street beneath it.
    const label = labelAt(event.point.x, event.point.y, map.getZoom() < 14 ? 20 : 7)
    if (label?.kind === 'place' && label.owner) return { kind: 'point' as const, id: label.owner }
    // Still fading in below zoom 15, a house is not yet something to tap.
    const house = map.getZoom() >= 15 ? houseAt(event.point) : null
    // Names are painted over everything, but a street name showing across a building that stands in front of that street is not what the finger meant.
    if (label && label.kind !== 'house' && !(house && standsBefore(map, house, label.lon, label.lat))) return { kind: 'label' as const, label }
    if (house) return { kind: 'house' as const, ...house }
    if (label) return { kind: 'label' as const, label }
    return { kind: 'ground' as const, lat: event.lngLat.lat, lon: event.lngLat.lng }
  }

  function fit(coordinates: number[][], padding: { top: number; bottom: number; left: number; right: number }, maxZoom = 17) {
    if (!coordinates.length) return
    const first = coordinates[0] as [number, number]
    const bounds = coordinates.reduce((box, point) => box.extend(point as [number, number]), new LngLatBounds(first, first))
    map.fitBounds(bounds, { padding, maxZoom, duration: 400 })
  }

  /** Bring a point into view without recentring when it is already comfortable. */
  function reveal(lat: number, lon: number, padding: { top: number; bottom: number }) {
    const size = map.getCanvas().getBoundingClientRect()
    const point = map.project([lon, lat])
    if (point.x > 40 && point.x < size.width - 40 && point.y > padding.top && point.y < size.height - padding.bottom) return
    map.easeTo({ center: [lon, lat], offset: [0, (padding.top - padding.bottom) / 2], duration: 350 })
  }

  /** Objects the admin panel is editing, drawn above the finished map. */
  function setEditorShapes(features: EditorShape[]) {
    push('editor', { type: 'FeatureCollection', features })
  }

  /** A draggable handle for one corner of an outline. */
  function vertex(lon: number, lat: number, onMove: (lon: number, lat: number) => void) {
    const element = document.createElement('div')
    element.className = 'admin-vertex'
    const handle = new Marker({ element, draggable: true, anchor: 'center' }).setLngLat([lon, lat])
    handle.on('drag', () => { const at = handle.getLngLat(); onMove(at.lng, at.lat) })
    return handle
  }

  function marker(html: string, className: string, anchor: 'bottom' | 'center' = 'bottom', onGround = false) {
    const element = document.createElement('div')
    element.className = className
    element.innerHTML = html
    return new Marker(onGround
      ? { element, anchor, rotationAlignment: 'map', pitchAlignment: 'map' }
      : { element, anchor })
  }

  /** While driving, the distance fades into haze and is revealed as you approach it. */
  function setDrivingView(driving: boolean) {
    const apply = () => {
      if (driving) {
        map.setSky({
          'sky-color': '#e9eee9', 'horizon-color': '#f3f2ec', 'fog-color': '#f1efe7',
          'sky-horizon-blend': 0.9, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.35, 'atmosphere-blend': 0,
        })
      } else {
        map.setSky(undefined as never)
      }
    }
    if (map.isStyleLoaded()) apply()
    else map.once('idle', apply)
  }

  function destroy() { map.off('render', drawLabels); text.remove(); map.remove() }

  return {
    map, ready, labelAt, pick, houseAt, houseRing, fit, reveal, marker, destroy, setDrivingView,
    /** Screen pixels from a ground point to the same point `metres` up, to stand a pin on a roof. */
    liftOffset: (lon: number, lat: number, metres: number) => liftOffset(map, lon, lat, metres),
    setLabels, setPoints, setPointFocus, setSelection, setRoutes, setLiveRoads, setBuildings, setOsmBuildings, setBuildingInfo, setAdminBuildings, setCityObjects,
    setEditorShapes, vertex, setLocationArrow, setTravelMode,
    setBuildingDetail: detail.setEnabled, buildingDetailStats: detail.stats,
  }
}

export type AtlasGL = ReturnType<typeof createAtlasGL>

export type LabelRoad = { id: string; groupId?: string; name: string | null; ref: string | null; coordinates: number[][] }
export type LabelDistrict = { id: string; name: string; center: [number, number] }
export type LabelEdits = {
  roads: LabelRoad[]
  districts: LabelDistrict[]
  roadNames: Record<string, string>
  districtNames: Record<string, string>
  buildings: { id: string; name?: string; geometry: { coordinates: number[][][] } }[]
}

/** Midpoint along the line itself, not the middle vertex or the bounding box. */
function midpoint(points: number[][]): [number, number] | null {
  if (!points?.length) return null
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    lengths.push(length)
    total += length
  }
  if (!total) return [points[0][0], points[0][1]]
  let left = total / 2
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]) {
      const t = lengths[i] ? left / lengths[i] : 0
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t]
    }
    left -= lengths[i]
  }
  return [points[0][0], points[0][1]]
}

/** Apply the admin's renames to the shipped labels and add the ones it invents. */
export function composeLabels(base: AtlasLabel[], edits: LabelEdits): AtlasLabel[] {
  const groupNames = new Map<string, string>()
  const byId = new Map(edits.roads.map(road => [road.id, road]))
  for (const [id, name] of Object.entries(edits.roadNames)) {
    const road = byId.get(id)
    if (road?.groupId) groupNames.set(road.groupId, name)
  }
  const owners = new Set<string>()
  const out = base.map(label => {
    if (label.owner) owners.add(label.owner)
    const renamed = label.owner
      ? edits.roadNames[label.owner] ?? groupNames.get(label.owner) ?? edits.districtNames[label.owner]
      : undefined
    return renamed ? { ...label, name: renamed } : label
  })
  for (const [id, name] of Object.entries(edits.roadNames)) {
    const road = byId.get(id)
    if (!road || owners.has(id) || (road.groupId && owners.has(road.groupId))) continue
    const centre = midpoint(road.coordinates)
    if (!centre) continue
    out.push({ lon: centre[0], lat: centre[1], name, kind: 'road', minzoom: 16, maxzoom: 20, owner: id })
    owners.add(id)
  }
  for (const district of edits.districts) {
    if (owners.has(district.id) || !Array.isArray(district.center)) continue
    out.push({
      lon: district.center[0], lat: district.center[1],
      name: edits.districtNames[district.id] ?? district.name,
      kind: 'district', minzoom: 14, maxzoom: null, owner: district.id,
    })
  }
  for (const building of edits.buildings) {
    const ring = building.geometry?.coordinates?.[0]
    if (!building.name || !ring?.length) continue
    const centre = midpoint(ring)
    if (centre) out.push({ lon: centre[0], lat: centre[1], name: building.name, kind: 'place', minzoom: 17, maxzoom: 20, owner: building.id })
  }
  return out
}

/** The label set shipped with the tiles, before any admin rename is applied. */
export async function baseLabels(): Promise<AtlasLabel[]> {
  const response = await fetch(siteUrl('/atlas-data/index.json?names=3'))
  if (!response.ok) throw Error('Не удалось загрузить названия')
  const meta = await response.json() as { labels: [number, number, string, string, number, number | null, string?, string?][] }
  return meta.labels.map(([nx, ny, name, kind, minzoom, maxzoom, , owner]) => {
    const [lon, lat] = unproject(nx, ny)
    // A district name has to survive zooming in, or it cannot be tapped.
    const cap = kind === 'neighbourhood' || kind === 'district' ? null : maxzoom ?? null
    return { lon, lat, name, kind, minzoom, maxzoom: cap, owner }
  })
}

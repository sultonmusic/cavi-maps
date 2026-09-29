/* Close-up building detail: facades (window grids per floor, shop fronts, doors), grey roofs,
   parapets, rooftop boxes, contact shadows and street trees around the middle of the map, drawn
   over MapLibre's extruded houses as one custom layer.

   The mesh covers a circle around the map's focus and is rebuilt, off the frame, once the focus
   has moved far enough or the data under it has changed. Decals fade in with the zoom and out
   towards the edge of the circle, so the rebuild never shows as a hard edge; solid details stay
   well inside the faded ring. Everything under a landmark is left to the landmark's own model. */
import { MercatorCoordinate, type CustomLayerInterface, type Map as GLMap, type StyleSpecification } from 'maplibre-gl'
import { bindSolid, bindTextured, composeMatrix, metreModel, solidProgram, texturedProgram, unbindSolid, unbindTextured, type SolidProgram, type TexturedProgram } from './gl-kit'
import { facadePixels, facadeTextures, type Pixels } from './facade-textures'
import { HOUSE_TONES, LIGHT, MAX_DECAL_VERTICES, MAX_SOLID_VERTICES, TEXTURE, TEXTURE_NAMES, buildFacades, liftedHeight, markStorefronts, outlineTone, worldRoof, type FacadeHouse, type FacadeMesh, type FacadeRange } from './facades.mjs'
import { STREET_TREES, lowTreeTriangles, openGround, parkTrees, streetTrees, worldGrid, type LocalRoad } from './greenery.mjs'
import { HOUSE_UNIT, housesNear, type HouseIndex } from './country-houses.mjs'
import { LANDMARKS, landmarkAt, landmarkCovers, mercX, mercY } from './landmarks.mjs'

/** The style's light, anchored to the map so walls keep their shading as the map turns, and the
    one lib/facades.mjs lights decals and solids with. */
export const BUILDING_LIGHT: NonNullable<StyleSpecification['light']> = {
  anchor: 'map', position: [LIGHT.radial, LIGHT.azimuth, LIGHT.polar], color: '#ffffff', intensity: LIGHT.intensity,
}
const TONE_MATCH = ['match', ['get', 'tone'], ...HOUSE_TONES.slice(0, -1).flatMap((tone, i) => [i, tone]), HOUSE_TONES[HOUSE_TONES.length - 1]]
/** Wall colour for the extruded houses: an admin's `colour` (#rrggbb) if the feature has one,
    else one of the eight tones by the feature's `tone` (houseTone of its key). */
export const BUILDING_COLOUR = ['case', ['has', 'colour'], ['to-color', ['get', 'colour'], TONE_MATCH], TONE_MATCH]

const LOW_MEMORY = typeof navigator !== 'undefined' && ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 2
export const DETAIL_MIN_ZOOM = 15.7, FADE_FROM = 15.9, FADE_TO = 16.5, SOLID_MIN_ZOOM = 16.2
/** Pitch in degrees over which walls appear and roofs turn from their tone to grey. */
export const ROOF_PITCH_FROM = 8, ROOF_PITCH_TO = 30
/** Metres around the focus that get decals, where they fade out, how far the focus may move
    before a rebuild, and how far solid details (parapets, boxes, trees) reach. */
export const RADIUS = LOW_MEMORY ? 320 : 450
export const FADE_RADIUS = LOW_MEMORY ? 250 : 360
export const REBUILD_METRES = LOW_MEMORY ? 70 : 90
export const SOLID_RADIUS = LOW_MEMORY ? 240 : 320
const MAX_STREET_TREES = LOW_MEMORY ? 350 : 700, MAX_PARK_TREES = LOW_MEMORY ? 250 : 500
/** Place categories that open a shop front on the ground floor of their house. */
const STOREFRONT = /^(shop|food|health|pharmacy|cafe|restaurant|market|supermarket|bank|service)/
const GROUP_UNITS = 65536
/** Houses dressed per slice of a rebuild, between which the main thread gets a breath. */
const SLICE = 120

/** A house of the map's own sources (Shaydon's footprints, admin buildings): ring in lon/lat,
    `height` exactly as its extrusion's `height` property, tone houseTone(id) unless given. */
export type LocalHouse = { id: string; ring: number[][]; height: number; roof?: string | null; style?: string | null; colour?: string | null; tone?: number | null; holes?: boolean }
/** A place as the map's points get it (MapPoint): its category decides whether it opens a shop front. */
export type DetailPlace = { id: string; lon: number; lat: number; category: string }
export type DetailSources = {
  houseList: () => Promise<Set<string>>
  houseFile: (name: string) => Promise<HouseIndex>
  approximateHeight: number
  local: () => LocalHouse[]
  roads: () => { id: string; coordinates: number[][]; asphalt: number; oneway?: boolean }[]
  trees: () => number[][]
}
/** What a rebuild made; `ms` from start to finish, `work` of it on the main thread, `longest` its longest stretch. */
export type DetailStats = { houses: number; skipped: number; decals: number; solids: number; trees: number; ms: number; work: number; longest: number }

type Mesh = { origin: MercatorCoordinate; focus: [number, number]; decals: Float32Array; ranges: FacadeRange[]; solids: Float32Array }

const smoothstep = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)))
  return t * t * (3 - 2 * t)
}
const metresBetween = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * Math.cos(a[1] * Math.PI / 180), a[1] - b[1]) * 111_320
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** The decals of several buildFacades slices as one buffer, still grouped by texture in TEXTURE order. */
function mergeDecals(parts: FacadeMesh[]) {
  const decals = new Float32Array(parts.reduce((sum, part) => sum + part.decals.length, 0)), ranges: FacadeRange[] = []
  let first = 0
  TEXTURE_NAMES.forEach((_, texture) => {
    let count = 0
    for (const part of parts) for (const range of part.ranges) {
      if (range.texture !== texture) continue
      decals.set(part.decals.subarray(range.first * 6, (range.first + range.count) * 6), (first + count) * 6)
      count += range.count
    }
    if (count) ranges.push({ texture, first, count })
    first += count
  })
  return { decals, ranges }
}

export function detailLayer(map: GLMap, sources: DetailSources) {
  let solid: SolidProgram | null = null, textured: TexturedProgram | null = null
  let decalBuffer: WebGLBuffer | null = null, solidBuffer: WebGLBuffer | null = null, textures: (WebGLTexture | null)[] | null = null
  let mesh: Mesh | null = null, dirty = false, decalCount = 0, solidCount = 0
  let enabled = true, version = 0, builtVersion = -1, token = 0
  let pending: { focus: [number, number]; version: number } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined, stats: DetailStats | null = null
  /** Every shop, café, pharmacy and bank the map has shown so far (id → lon/lat). The map is given
      only the places near its middle, and only those a search or a category leaves, so the set
      only grows: a filter never turns a shop front back into windows. */
  const storefronts = new Map<string, [number, number]>()
  /** The textures' pixels, painted during the first rebuild so the first close frame only uploads them. */
  let painted: Pixels[] | null = null

  const layer: CustomLayerInterface = {
    id: 'city-detail', type: 'custom', renderingMode: '3d',
    onAdd(_map, gl) {
      solid = solidProgram(gl)
      textured = texturedProgram(gl)
      decalBuffer = gl.createBuffer()
      solidBuffer = gl.createBuffer()
      textures = null
      dirty = true
    },
    onRemove(_map, gl) {
      if (solid) gl.deleteProgram(solid.program)
      if (textured) gl.deleteProgram(textured.program)
      gl.deleteBuffer(decalBuffer)
      gl.deleteBuffer(solidBuffer)
      for (const texture of textures ?? []) gl.deleteTexture(texture)
      solid = textured = null
      decalBuffer = solidBuffer = null
      textures = null
    },
    render(gl, { defaultProjectionData }) {
      const zoom = map.getZoom()
      if (!enabled || !mesh || !solid || !textured || zoom < FADE_FROM) return
      // Textures go up inside render(), where MapLibre expects texture state to change.
      textures ??= facadeTextures(gl, painted ?? undefined)
      if (dirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, decalBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, mesh.decals, gl.STATIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, solidBuffer)
        gl.bufferData(gl.ARRAY_BUFFER, mesh.solids, gl.STATIC_DRAW)
        decalCount = mesh.decals.length / 6
        solidCount = mesh.solids.length / 7
        dirty = false
      }
      const matrix = composeMatrix(defaultProjectionData.mainMatrix, metreModel(mesh.origin))
      const scale = mesh.origin.meterInMercatorCoordinateUnits(), focus = MercatorCoordinate.fromLngLat(focusPoint())
      const fx = (focus.x - mesh.origin.x) / scale, fy = (mesh.origin.y - focus.y) / scale
      const shadow = mesh.ranges.find(range => range.texture === TEXTURE.shadow)
      const draw = (range: FacadeRange) => {
        gl.bindTexture(gl.TEXTURE_2D, textures?.[range.texture] ?? null)
        gl.drawArrays(gl.TRIANGLES, range.first, range.count)
      }
      gl.activeTexture(gl.TEXTURE0)

      // Contact shadows lie on the ground and must not hide what stands on them.
      gl.depthMask(false)
      if (decalCount) {
        bindTextured(gl, textured, decalBuffer, matrix)
        gl.uniform3f(textured.fade, fx, fy, FADE_RADIUS)
        gl.uniform1f(textured.opacity, smoothstep(FADE_FROM, FADE_TO, zoom))
        if (shadow) draw(shadow)
        unbindTextured(gl, textured)
      }

      // Parapets, rooftop boxes, canopies and trees: real geometry that hides what is behind it.
      if (zoom >= SOLID_MIN_ZOOM && solidCount) {
        gl.depthMask(true)
        bindSolid(gl, solid, solidBuffer, matrix)
        gl.drawArrays(gl.TRIANGLES, 0, solidCount)
        unbindSolid(gl, solid)
      }

      // Windows, doors and roofs: a few centimetres in front of the walls they dress, pulled a
      // little further forward in depth so they never flicker, and writing no depth themselves.
      if (decalCount) {
        gl.depthMask(false)
        gl.enable(gl.POLYGON_OFFSET_FILL)
        gl.polygonOffset(-1, -2)
        bindTextured(gl, textured, decalBuffer, matrix)
        gl.uniform3f(textured.fade, fx, fy, FADE_RADIUS)
        // Seen from straight above, walls are edge-on and not worth drawing, and grey roofs in a
        // circle around the middle would read as a patch among the toned roofs further out: the
        // roofs turn grey only as the map tilts, together with the walls rising into view.
        const pitch = map.getPitch(), zoomFade = smoothstep(FADE_FROM, FADE_TO, zoom), roofFade = smoothstep(ROOF_PITCH_FROM, ROOF_PITCH_TO, pitch)
        for (const range of mesh.ranges) {
          if (range.texture === TEXTURE.shadow) continue
          const fade = range.texture === TEXTURE.roof ? roofFade : pitch < ROOF_PITCH_FROM ? 0 : 1
          if (!fade) continue
          gl.uniform1f(textured.opacity, zoomFade * fade)
          draw(range)
        }
        unbindTextured(gl, textured)
        gl.disable(gl.POLYGON_OFFSET_FILL)
        gl.polygonOffset(0, 0)
      }
      gl.depthMask(true)
      gl.bindTexture(gl.TEXTURE_2D, null)
    },
  }

  /** Where the viewer looks: the middle of the map, or a little below it in a steep view, where
      the nearest houses are. */
  function focusPoint(): [number, number] {
    if (map.getPitch() <= 40) {
      const centre = map.getCenter()
      return [centre.lng, centre.lat]
    }
    const box = map.getContainer()
    const point = map.unproject([box.clientWidth / 2, box.clientHeight * 0.6])
    return [point.lng, point.lat]
  }

  function schedule(delay: number) {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const mine = token + 1
      rebuild().catch(error => {
        // A broken house or street must not stop the map: keep the last mesh and let the next
        // move try again.
        if (mine === token) pending = null
        console.warn('city-detail', error)
      })
    }, delay)
  }

  function check(delay = 60) {
    if (!enabled) return
    const zoom = map.getZoom()
    if (zoom < 15) {
      // Far out: drop the mesh, and any rebuild still on its way.
      clearTimeout(timer)
      if (pending) { token++; pending = null }
      if (mesh) { mesh = null; dirty = true; map.triggerRepaint() }
      return
    }
    if (zoom < DETAIL_MIN_ZOOM) return
    const focus = focusPoint()
    const current = pending ?? (mesh ? { focus: mesh.focus, version: builtVersion } : null)
    if (!current || current.version !== version || metresBetween(focus, current.focus) > REBUILD_METRES) schedule(delay)
  }

  async function rebuild() {
    const mine = ++token, started = performance.now(), focus = focusPoint(), forVersion = version
    pending = { focus, version: forVersion }
    // Main-thread time, stretch by stretch between the awaits.
    let work = 0, longest = 0, mark = started
    const rest = async <T>(promise: Promise<T>) => {
      const spent = performance.now() - mark
      work += spent; longest = Math.max(longest, spent)
      const value = await promise
      mark = performance.now()
      return value
    }
    const origin = MercatorCoordinate.fromLngLat(focus), scale = origin.meterInMercatorCoordinateUnits()
    const local = (mx: number, my: number): [number, number] => [(mx - origin.x) / scale, (origin.y - my) / scale]
    const fromLngLat = (lon: number, lat: number) => local(mercX(lon), mercY(lat))
    const houses: FacadeHouse[] = []
    // Only a rebuild near a landmark needs to ask, house by house, whether it stands under one.
    const nearLandmark = LANDMARKS.some(landmark => metresBetween(focus, landmark.centre) < RADIUS + 1000)
    const underLandmark = (ring: number[][]) => nearLandmark && landmarkCovers(ring)

    // The country's houses from their files, as world units around the focus.
    const X = origin.x * HOUSE_UNIT, Y = origin.y * HOUSE_UNIT, reach = RADIUS * scale * HOUSE_UNIT
    let files: [string, HouseIndex][] = []
    try {
      const listed = await rest(sources.houseList()), names: string[] = []
      for (let gx = Math.floor((X - reach) / GROUP_UNITS); gx <= Math.floor((X + reach) / GROUP_UNITS); gx++) {
        for (let gy = Math.floor((Y - reach) / GROUP_UNITS); gy <= Math.floor((Y + reach) / GROUP_UNITS); gy++) {
          if (listed.has(`${gx}-${gy}`)) names.push(`${gx}-${gy}`)
        }
      }
      files = await rest(Promise.all(names.map(async name => [name, await sources.houseFile(name)] as [string, HouseIndex])))
    } catch { /* offline and not cached yet: the map's own houses still get their detail */ }
    if (mine !== token) return
    for (const [name, index] of files) {
      const [gx, gy] = name.split('-').map(Number)
      for (const house of housesNear(index, gx, gy, X, Y, reach)) {
        const mercator: number[][] = [], ring: number[][] = []
        for (let i = 0; i < house.points.length; i += 2) {
          const mx = house.points[i] / HOUSE_UNIT, my = house.points[i + 1] / HOUSE_UNIT
          mercator.push([mx, my])
          ring.push(local(mx, my))
        }
        if (underLandmark(mercator)) continue
        // As tall and in the tone the houses:// tiles give its extrusion.
        const tone = outlineTone(house.outline)
        houses.push({
          id: `cty:${name}:${house.index}`, ring, tone, height: liftedHeight(house.height || sources.approximateHeight, tone),
          style: house.style, gap: house.gap / HOUSE_UNIT / scale,
        })
      }
    }

    // Shaydon's footprints and the admin's buildings.
    for (const house of sources.local()) {
      const first = house.ring[0]
      if (!first || metresBetween([first[0], first[1]], focus) > RADIUS + 150) continue
      const mercator = house.ring.map(([lon, lat]) => [mercX(lon), mercY(lat)])
      if (underLandmark(mercator)) continue
      const ring = mercator.map(([mx, my]) => local(mx, my))
      let sx = 0, sy = 0
      for (const [x, y] of ring) { sx += x; sy += y }
      const gap = Math.hypot(sx / ring.length, sy / ring.length)
      if (gap > RADIUS) continue
      houses.push({ id: house.id, ring, height: house.height, roof: house.roof, style: house.style, colour: house.colour, tone: house.tone, holes: house.holes, gap })
    }

    // Shops, cafés, pharmacies and banks open their house's ground floor.
    const fronts: number[][] = []
    for (const [lon, lat] of storefronts.values()) {
      if (metresBetween([lon, lat], focus) > RADIUS + 20) continue
      const point = fromLngLat(lon, lat)
      if (Math.hypot(point[0], point[1]) < RADIUS + 10) fronts.push(point)
    }
    markStorefronts(houses, fronts)
    await rest(pause())
    if (mine !== token) return
    if (!painted) {
      const list: Pixels[] = []
      for (const name of TEXTURE_NAMES) {
        list.push(facadePixels(name))
        await rest(pause())
        if (mine !== token) return
      }
      painted = list
    }

    // Facades nearest first, a slice at a time with a pause between, so a rebuild never holds the
    // main thread for long; the vertex budgets carry over from slice to slice. The roof pattern
    // and the park grid are fixed in Web Mercator, so neither jumps when the mesh is rebuilt
    // around another origin, whichever way the map moved.
    const { roofSize, roofOffset } = worldRoof(origin.x, origin.y, scale)
    houses.sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0))
    const parts: FacadeMesh[] = []
    let decalRoom = MAX_DECAL_VERTICES, solidRoom = MAX_SOLID_VERTICES, built = 0, skipped = 0
    for (let from = 0; from < houses.length;) {
      let to = Math.min(houses.length, from + SLICE)
      // Copies of one outline stand at one gap: they stay in one slice, which dresses one of them.
      while (to < houses.length && houses[to].gap === houses[to - 1].gap) to++
      const part = buildFacades(houses.slice(from, to), { solidRadius: SOLID_RADIUS, roofOffset, roofSize, maxDecals: decalRoom, maxSolids: solidRoom })
      parts.push(part)
      built += part.houses
      decalRoom -= part.decals.length / 6
      solidRoom -= part.solids.length / 7
      if (part.skipped) { skipped = part.skipped + houses.length - to; break }
      from = to
      await rest(pause())
      if (mine !== token) return
    }
    const { decals, ranges } = mergeDecals(parts)
    const facadeSolids = parts.map(part => part.solids)
    let trees = 0
    if (STREET_TREES) {
      await rest(pause())
      if (mine !== token) return
      const roads: LocalRoad[] = sources.roads().map(road => ({
        id: road.id, asphalt: road.asphalt, oneway: road.oneway, line: road.coordinates.map(([lon, lat]) => fromLngLat(lon, lat)),
      })).filter(road => road.line.some(([x, y]) => Math.hypot(x, y) < SOLID_RADIUS + 400))
      const mapped = sources.trees().map(([lon, lat]) => fromLngLat(lon, lat)).filter(([x, y]) => Math.hypot(x, y) < SOLID_RADIUS + 20)
      // Parks get a loose grid of trees; water keeps every tree out (a street's row along a bridge).
      // Either outline can be far larger than the circle, so each is kept when its box meets it.
      const parks: number[][][] = [], water: number[][][] = []
      const reachLat = (SOLID_RADIUS + 300) / 111_320, reachLon = reachLat / Math.cos(focus[1] * Math.PI / 180)
      try {
        for (const feature of map.querySourceFeatures('atlas', { sourceLayer: 'areas', filter: ['in', ['get', 'kind'], ['literal', ['park', 'water']]] })) {
          const geometry = feature.geometry, into = feature.properties?.kind === 'water' ? water : parks
          const outers: number[][][] = geometry.type === 'Polygon' ? [geometry.coordinates[0] as number[][]]
            : geometry.type === 'MultiPolygon' ? (geometry.coordinates as number[][][][]).map(polygon => polygon[0]) : []
          for (const outer of outers) {
            let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
            for (const [lon, lat] of outer) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat) }
            if (west > focus[0] + reachLon || east < focus[0] - reachLon || south > focus[1] + reachLat || north < focus[1] - reachLat) continue
            into.push(outer.map(([lon, lat]) => fromLngLat(lon, lat)))
          }
        }
      } catch { /* the atlas source is not ready yet */ }
      const open = openGround(houses.map(house => house.ring), roads, mapped, water)
      const lonLat = (x: number, y: number) => {
        const mx = origin.x + x * scale, my = origin.y - y * scale
        return [mx * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180 / Math.PI]
      }
      const isFree = (x: number, y: number) => {
        if (!open(x, y)) return false
        if (!nearLandmark) return true
        const [lon, lat] = lonLat(x, y)
        return !landmarkAt(lon, lat)
      }
      const planted = [
        ...streetTrees(roads, isFree, { centre: [0, 0], radius: SOLID_RADIUS, max: MAX_STREET_TREES }),
        ...parkTrees(parks, isFree, { centre: [0, 0], radius: SOLID_RADIUS, max: MAX_PARK_TREES, ...worldGrid(origin.x, origin.y, scale) }),
      ]
      await rest(pause())
      if (mine !== token) return
      if (planted.length) {
        const triangles: number[] = []
        for (const tree of planted) lowTreeTriangles(tree.x, tree.y, tree.height, tree.crown, tree.leaf, triangles)
        facadeSolids.push(Float32Array.from(triangles))
        trees = planted.length
      }
    }
    if (mine !== token) return
    const solids = new Float32Array(facadeSolids.reduce((sum, part) => sum + part.length, 0))
    facadeSolids.reduce((at, part) => { solids.set(part, at); return at + part.length }, 0)
    mesh = { origin, focus, decals, ranges, solids }
    builtVersion = forVersion
    pending = null
    dirty = true
    const now = performance.now()
    work += now - mark; longest = Math.max(longest, now - mark)
    stats = { houses: built, skipped, decals: decals.length / 6, solids: solids.length / 7, trees, ms: Math.round(now - started), work: Math.round(work), longest: Math.round(longest) }
    map.triggerRepaint()
  }

  for (const event of ['moveend', 'zoomend', 'idle'] as const) map.on(event, () => check())

  return {
    layer,
    /** The houses, streets or trees under the detail changed: rebuild it soon. */
    invalidate() {
      version++
      check(200)
    },
    /** The places the map now shows (setPoints): a shop, café, pharmacy or bank not seen before
        rebuilds the detail when it stands within the dressed circle, to open its shop front. */
    addPlaces(points: readonly DetailPlace[]) {
      const around = [pending?.focus, mesh?.focus].filter((focus): focus is [number, number] => !!focus)
      let near = false
      for (const point of points) {
        if (!STOREFRONT.test(point.category) || storefronts.has(point.id) || !Number.isFinite(point.lon) || !Number.isFinite(point.lat)) continue
        storefronts.set(point.id, [point.lon, point.lat])
        if (!near && around.some(focus => metresBetween([point.lon, point.lat], focus) < RADIUS + 10)) near = true
      }
      if (near) { version++; check(200) }
    },
    /** Profile switch «Подробные здания»: off drops the mesh and its rebuilds. */
    setEnabled(on: boolean) {
      if (on === enabled) return
      enabled = on
      if (!on) { clearTimeout(timer); token++; pending = null; mesh = null; dirty = true } else check()
      map.triggerRepaint()
    },
    /** What the last rebuild made, for the console. */
    stats: () => stats,
  }
}

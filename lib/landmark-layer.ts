/* The landmarks' own 3D layer: one static mesh per landmark, built the first time it comes into view,
   measured from the landmark's centre so a 200 m building keeps float precision. Drawn with the same
   solid program as the roofs and trees, and faded in over one zoom like the houses. A landmark out of
   the view is neither built nor drawn. */
import { MercatorCoordinate, type CustomLayerInterface, type Map as GLMap } from 'maplibre-gl'
import { LANDMARKS, MAX_LANDMARK_VERTICES, isNightInDushanbe, landmarkOutline, landmarkSilhouette, type Landmark } from './landmarks.mjs'

type GL = WebGLRenderingContext | WebGL2RenderingContext
/** The solid-mesh tools of atlas-gl.ts (lib/gl-kit.ts once item #8 moves them there). */
export type SolidKit<P extends { program: WebGLProgram }> = {
  solidProgram: (gl: GL) => P | null
  bindSolid: (gl: GL, solid: P, buffer: WebGLBuffer | null, matrix: Float32Array) => void
  unbindSolid: (gl: GL, solid: P) => void
  composeMatrix: (view: ArrayLike<number>, model: number[]) => Float32Array
}
/** For lib/building-pick.ts (item #6): a landmark as a prism the tap ray can hit. */
export type LandmarkSolid = { record: { key: string; source: 'landmark'; ring: number[][]; height: number; label: string }; top: number }

/** Metres from the middle of the map beyond which a landmark is neither drawn nor built: further out,
    even the horizon of a steep view shows it a few pixels big. */
const REACH = 8000

/** Whether a box about the model origin, `extent` metres each way and 0 to `top` metres up, can
    show through `m`: false only when all eight corners lie beyond one plane of the view. */
function inView(m: Float32Array, extent: number, top: number) {
  let left = 0, right = 0, low = 0, high = 0, behind = 0
  for (let k = 0; k < 8; k++) {
    const e = k & 1 ? extent : -extent, n = k & 2 ? extent : -extent, z = k & 4 ? top : 0
    const x = m[0] * e + m[4] * n + m[8] * z + m[12], y = m[1] * e + m[5] * n + m[9] * z + m[13], w = m[3] * e + m[7] * n + m[11] * z + m[15]
    if (x < -w) left++
    if (x > w) right++
    if (y < -w) low++
    if (y > w) high++
    if (w <= 0) behind++
  }
  return left < 8 && right < 8 && low < 8 && high < 8 && behind < 8
}

const metresBetween = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * Math.cos(a[1] * Math.PI / 180), a[1] - b[1]) * 111_320

export function landmarkLayer<P extends { program: WebGLProgram }>(map: GLMap, kit: SolidKit<P>) {
  type Slot = { landmark: Landmark; origin: MercatorCoordinate; buffer: WebGLBuffer | null; count: number; night: boolean | null; matrix: Float32Array | null }
  let solid: P | null = null, slots: Slot[] = [], checked = 0, night = isNightInDushanbe()

  const layer: CustomLayerInterface = {
    id: 'landmarks', type: 'custom', renderingMode: '3d',
    onAdd(_map, gl) {
      solid = kit.solidProgram(gl)
      slots = LANDMARKS.map(landmark => ({ landmark, origin: MercatorCoordinate.fromLngLat(landmark.centre), buffer: gl.createBuffer(), count: 0, night: null, matrix: null }))
    },
    onRemove(_map, gl) {
      if (solid) gl.deleteProgram(solid.program)
      for (const slot of slots) gl.deleteBuffer(slot.buffer)
      solid = null
      slots = []
    },
    render(gl, { defaultProjectionData }) {
      if (!solid) return
      const zoom = map.getZoom(), centre = map.getCenter(), now = Date.now()
      // The media facade lights up at dusk: look at the clock once a minute (or at once when the
      // clock is set back), rebuild when it turns.
      if (Math.abs(now - checked) > 60_000) { checked = now; night = isNightInDushanbe(new Date(now)) }
      for (const slot of slots) {
        slot.matrix = null
        const { landmark } = slot
        if (zoom < landmark.minzoom || metresBetween([centre.lng, centre.lat], landmark.centre) > REACH) continue
        const scale = slot.origin.meterInMercatorCoordinateUnits()
        // East, north and up in metres, into mercator units whose y grows southwards.
        const model = [scale, 0, 0, 0, 0, -scale, 0, 0, 0, 0, scale, 0, slot.origin.x, slot.origin.y, 0, 1]
        const matrix = kit.composeMatrix(defaultProjectionData.mainMatrix, model)
        if (!inView(matrix, landmark.extent, landmark.top + 1)) continue
        if (slot.night !== night) {
          const data = landmark.build(night)
          slot.night = night
          slot.count = data.length / 7 <= MAX_LANDMARK_VERTICES ? data.length / 7 : 0
          gl.bindBuffer(gl.ARRAY_BUFFER, slot.buffer)
          gl.bufferData(gl.ARRAY_BUFFER, slot.count ? data : new Float32Array(0), gl.STATIC_DRAW)
        }
        if (!slot.count) continue
        slot.matrix = matrix
        kit.bindSolid(gl, solid, slot.buffer, matrix)
        const fade = Math.min(1, zoom - landmark.minzoom)
        if (fade < 1) {
          // Fade as one surface: lay down depth first, then blend only the front-most faces.
          gl.colorMask(false, false, false, false)
          gl.drawArrays(gl.TRIANGLES, 0, slot.count)
          gl.colorMask(true, true, true, true)
          gl.depthFunc(gl.LEQUAL)
          gl.enable(gl.BLEND)
          gl.blendColor(0, 0, 0, fade)
          gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA)
        }
        gl.drawArrays(gl.TRIANGLES, 0, slot.count)
        // MapLibre marks its GL state dirty after a custom layer, but leave blending as it expects.
        if (fade < 1) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        kit.unbindSolid(gl, solid)
      }
    },
  }

  /** The landmark under a screen point, from the silhouette drawn in the last frame: the convex hull
      of its outline at the ground and at its top, projected with the layer's own matrix. */
  function hit(point: { x: number; y: number }): Landmark | null {
    const canvas = map.getCanvas(), width = canvas.clientWidth, height = canvas.clientHeight
    for (const slot of slots) {
      const m = slot.matrix
      if (!m) continue
      const screen: [number, number][] = []
      let behind = false
      for (const [e, n] of landmarkSilhouette(slot.landmark)) for (const z of [0, slot.landmark.top]) {
        const w = m[3] * e + m[7] * n + m[11] * z + m[15]
        if (w <= 0) { behind = true; break }
        screen.push([((m[0] * e + m[4] * n + m[8] * z + m[12]) / w + 1) / 2 * width, (1 - (m[1] * e + m[5] * n + m[9] * z + m[13]) / w) / 2 * height])
      }
      if (behind) continue
      if (insideHull(hull(screen), point.x, point.y)) return slot.landmark
    }
    return null
  }

  /** For item #6's ray test: each landmark near enough to be drawn, as a prism from the ground to its top. */
  function solids(): LandmarkSolid[] {
    return slots.filter(slot => slot.matrix).map(({ landmark }) => ({
      record: { key: landmark.key, source: 'landmark' as const, ring: landmarkOutline(landmark), height: landmark.top, label: landmark.place.tags.name },
      top: landmark.top,
    }))
  }

  return { layer, hit, solids }
}

/** Convex hull by monotone chain, anticlockwise in screen space (y down). */
function hull(points: [number, number][]) {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const turn = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const chain = (list: [number, number][]) => {
    const kept: [number, number][] = []
    for (const point of list) {
      while (kept.length >= 2 && turn(kept[kept.length - 2], kept[kept.length - 1], point) <= 0) kept.pop()
      kept.push(point)
    }
    return kept.slice(0, -1)
  }
  return [...chain(sorted), ...chain([...sorted].reverse())]
}

function insideHull(ring: [number, number][], x: number, y: number) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

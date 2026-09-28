export type Road = {
  id: string
  coordinates: number[][]
  name: string | null
  ref: string | null
  tags: Record<string, string>
  bbox: number[]
  namingStatus?: 'source' | 'proposed'
  groupId?: string
}

export type StreetPoint = { lat: number; lon: number }
export type StreetMatch = StreetPoint & { road: Road; distanceMeters: number }
type Segment = { road: Road; ax: number; ay: number; bx: number; by: number }

const R = 6_371_008.8
const RAD = Math.PI / 180
const CELL = 0.01
const MAX_SEGMENT_CELLS = 256
const MAX_QUERY_CELLS = 20_000

function coordinate(value: unknown): value is number[] {
  return Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
}

function distance(a: StreetPoint, b: StreetPoint) {
  const dlat = (b.lat - a.lat) * RAD
  const dlon = (b.lon - a.lon) * RAD
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dlon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))))
}

function roadSegments(road: Road): Segment[] {
  if (!Array.isArray(road.coordinates)) return []
  const result: Segment[] = []
  let previous: number[] | null = null
  for (const point of road.coordinates) {
    if (!coordinate(point)) {
      // A bad vertex is a break, never an invented connection across missing geometry.
      previous = null
      continue
    }
    if (previous) result.push({ road, ax: previous[0], ay: previous[1], bx: point[0], by: point[1] })
    previous = point
  }
  return result
}

/** Midpoint along the valid road geometry, not the middle vertex or its bounding box. */
export function roadPoint(road: Road): StreetPoint | null {
  const parts = roadSegments(road)
  const lengths = parts.map(s => distance({ lat: s.ay, lon: s.ax }, { lat: s.by, lon: s.bx }))
  const total = lengths.reduce((sum, value) => sum + value, 0)
  if (total > 0) {
    let remaining = total / 2
    for (let i = 0; i < parts.length; i++) {
      const length = lengths[i]
      if (!length) continue
      const s = parts[i]
      if (remaining <= length) {
        const t = remaining / length
        return { lat: s.ay + t * (s.by - s.ay), lon: s.ax + t * (s.bx - s.ax) }
      }
      remaining -= length
    }
  }
  const first = Array.isArray(road.coordinates) ? road.coordinates.find(coordinate) : undefined
  return first ? { lat: first[1], lon: first[0] } : null
}

function project(segment: Segment, lat: number, lon: number): StreetPoint {
  // Project onto the actual segment in a metric plane centred on the click latitude.
  // Road vertices are [longitude, latitude]; this is deliberately independent of labels.
  const cos = Math.max(1e-9, Math.cos(lat * RAD))
  const ax = (segment.ax - lon) * cos
  const ay = segment.ay - lat
  const dx = (segment.bx - segment.ax) * cos
  const dy = segment.by - segment.ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0
  return { lat: segment.ay + t * (segment.by - segment.ay), lon: segment.ax + t * (segment.bx - segment.ax) }
}

function namingRank(road: Road) {
  return typeof road.name === 'string' && road.name.trim() ? 2 : typeof road.ref === 'string' && road.ref.trim() ? 1 : 0
}

/** A local, segment-based reverse street lookup. The supplied bbox is never trusted. */
export function createStreetIndex(roads: Road[]) {
  const byId = new Map<string, Road>()
  const segments: Segment[] = []
  const grid = new Map<string, number[]>()
  const longSegments: number[] = []
  for (const road of roads) {
    if (!road || typeof road.id !== 'string' || !road.id || byId.has(road.id)) continue
    byId.set(road.id, road)
    for (const segment of roadSegments(road)) {
      const id = segments.push(segment) - 1
      const x0 = Math.floor(Math.min(segment.ax, segment.bx) / CELL)
      const x1 = Math.floor(Math.max(segment.ax, segment.bx) / CELL)
      const y0 = Math.floor(Math.min(segment.ay, segment.by) / CELL)
      const y1 = Math.floor(Math.max(segment.ay, segment.by) / CELL)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_SEGMENT_CELLS) {
        longSegments.push(id)
        continue
      }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`
        const bucket = grid.get(key)
        if (bucket) bucket.push(id)
        else grid.set(key, [id])
      }
    }
  }

  function nearest(lat: number, lon: number, radiusMeters: number): StreetMatch | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
      !Number.isFinite(radiusMeters) || radiusMeters < 0) return null
    const angular = Math.min(Math.PI, radiusMeters / R)
    const latDelta = angular / RAD
    const reachesPole = Math.abs(lat) + latDelta >= 90
    const lonRatio = Math.sin(angular) / Math.max(1e-9, Math.cos(lat * RAD))
    const lonDelta = reachesPole || angular >= Math.PI / 2 ? 180 : Math.asin(Math.min(1, Math.abs(lonRatio))) / RAD
    const x0 = Math.floor((lon - lonDelta) / CELL)
    const x1 = Math.floor((lon + lonDelta) / CELL)
    const y0 = Math.floor((lat - latDelta) / CELL)
    const y1 = Math.floor((lat + latDelta) / CELL)
    let result: StreetMatch | null = null
    const examine = (id: number) => {
      const segment = segments[id]
      const point = project(segment, lat, lon)
      const meters = distance({ lat, lon }, point)
      if (meters > radiusMeters + 1e-7) return
      const tie = result && Math.abs(meters - result.distanceMeters) <= 1e-6
      const preferred = result && (namingRank(segment.road) > namingRank(result.road) ||
        (namingRank(segment.road) === namingRank(result.road) && segment.road.id < result.road.id))
      if (!result || meters < result.distanceMeters - 1e-6 || (tie && preferred)) {
        result = { road: segment.road, ...point, distanceMeters: meters }
      }
    }
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_QUERY_CELLS || lon - lonDelta < -180 || lon + lonDelta > 180) {
      for (let id = 0; id < segments.length; id++) examine(id)
    } else {
      const candidates = new Set<number>(longSegments)
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const bucket = grid.get(`${x},${y}`)
        if (bucket) for (const id of bucket) candidates.add(id)
      }
      for (const id of candidates) examine(id)
    }
    return result
  }

  return { byId, nearest }
}

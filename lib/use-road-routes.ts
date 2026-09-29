'use client'
/**
 * Whole roads with their numbers and names (public/road-routes.json), with the admin's live edits
 * applied. The admin also loads the unlabelled strokes (road-routes-extra.json) so any main road can
 * be given a number; the public map loads them only once such an edit exists.
 * Pages push `routes` to the map themselves: atlas.setRoadRoutes(api.routes).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { siteUrl } from './site-url'
import type { MapPlace } from './map-places'
import {
  applyRouteEdits, createRouteIndex, decodeRoadRoutes, findRoutes, isLabelled, routePlace, routeShape,
  type RoadRoute, type RoadRoutesFile, type RouteEdit,
} from './road-routes'

export type RoadRoutesApi = {
  ready: boolean
  /** Edits applied; extra strokes only when edited (public) or always (admin). */
  routes: RoadRoute[]
  byId: Map<string, RoadRoute>
  /** The same routes before edits. */
  base: Map<string, RoadRoute>
  /** A search place for every labelled road. */
  places: MapPlace[]
  find(query: string, limit?: number): RoadRoute[]
  nearest(lat: number, lon: number, radiusMeters: number): RoadRoute | null
  routeOfWay(wayId: string): RoadRoute | null
  /** A card for a road; `text` is a tapped name along it and `at` the tapped point. */
  place(routeId: string, text?: string, at?: { lat: number; lon: number }): MapPlace | null
  /** The road's shape to highlight; with `name`, only its ways of that name. */
  shape(routeId: string, name?: string | null): { type: 'MultiLineString'; coordinates: number[][][] } | null
  bounds(routeId: string): [number, number, number, number] | null
}

const files = new Map<string, Promise<RoadRoute[]>>()
function load(path: string): Promise<RoadRoute[]> {
  let promise = files.get(path)
  if (!promise) {
    promise = fetch(siteUrl(path))
      .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<RoadRoutesFile> })
      .then(decodeRoadRoutes)
      .catch(error => { console.warn(`Номера дорог не загрузились (${path}):`, error); files.delete(path); return [] as RoadRoute[] })
    files.set(path, promise)
  }
  return promise
}

type Signed = [roadId: string, ref: string | null, name: string | null]

export function useRoadRoutes(edits: Record<string, RouteEdit>, options: { admin?: boolean } = {}): RoadRoutesApi {
  const admin = !!options.admin
  const [labelled, setLabelled] = useState<RoadRoute[] | null>(null)
  const [extra, setExtra] = useState<RoadRoute[] | null>(null)
  const wantsExtra = admin || Object.keys(edits ?? {}).some(key => key.startsWith('route/way:'))

  useEffect(() => {
    let cancelled = false
    void load('/road-routes.json').then(routes => { if (!cancelled) setLabelled(routes) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!wantsExtra) return
    let cancelled = false
    void load('/road-routes-extra.json').then(routes => { if (!cancelled) setExtra(routes) })
    return () => { cancelled = true }
  }, [wantsExtra])

  const baseList = useMemo(() => [...(labelled ?? []), ...(wantsExtra ? extra ?? [] : [])], [labelled, extra, wantsExtra])
  const base = useMemo(() => new Map(baseList.map(route => [route.id, route])), [baseList])
  const wayIds = useMemo(() => new Set(baseList.flatMap(route => route.ways.map(way => way.id))), [baseList])

  // Only edits that change a road count, so a Firestore snapshot that touches nothing else
  // (metadata, asphalt, another collection) keeps every derived value as it is.
  const signature = JSON.stringify(Object.values(edits ?? {})
    .filter(edit => edit && typeof edit.roadId === 'string' && (edit.roadId.startsWith('route/') || (wayIds.has(edit.roadId) && typeof edit.name === 'string')))
    .map((edit): Signed => [edit.roadId, typeof edit.ref === 'string' ? edit.ref : null, typeof edit.name === 'string' ? edit.name : null])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))

  const routes = useMemo(() => {
    const relevant: Record<string, RouteEdit> = {}
    for (const [roadId, ref, name] of JSON.parse(signature) as Signed[]) {
      relevant[roadId] = { roadId, ...(ref !== null ? { ref } : {}), ...(name !== null ? { name } : {}) }
    }
    const edited = applyRouteEdits(baseList, relevant)
    return admin ? edited : edited.filter(route => !route.extra || route.edited)
  }, [baseList, signature, admin])

  const byId = useMemo(() => new Map(routes.map(route => [route.id, route])), [routes])
  const places = useMemo(() => routes.filter(isLabelled).map(route => routePlace(route)), [routes])
  const byWay = useMemo(() => {
    const map = new Map<string, RoadRoute>()
    for (const route of routes) for (const way of route.ways) if (!map.has(way.id)) map.set(way.id, route)
    return map
  }, [routes])
  // The tap index is built on first use: the public map rarely needs it.
  const index = useRef<{ routes: RoadRoute[]; value: ReturnType<typeof createRouteIndex> } | null>(null)

  return useMemo<RoadRoutesApi>(() => {
    const indexed = () => {
      if (index.current?.routes !== routes) index.current = { routes, value: createRouteIndex(routes) }
      return index.current.value
    }
    return {
      ready: labelled !== null && (!admin || extra !== null),
      routes, byId, base, places,
      find: (query, limit = 20) => findRoutes(routes, query, limit, admin),
      nearest: (lat, lon, radiusMeters) => indexed().nearest(lat, lon, radiusMeters),
      routeOfWay: wayId => byWay.get(wayId) ?? null,
      place: (routeId, text, at) => { const route = byId.get(routeId); return route ? routePlace(route, text, at) : null },
      shape: (routeId, name) => { const route = byId.get(routeId); return route ? routeShape(route, name) : null },
      bounds: routeId => byId.get(routeId)?.bbox ?? null,
    }
  }, [routes, byId, byWay, base, places, labelled, extra, admin])
}

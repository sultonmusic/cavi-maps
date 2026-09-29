'use client'

import { siteUrl } from './site-url'
import { useCallback, useEffect, useRef, useState } from 'react'
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInAnonymously, signOut, type Auth } from 'firebase/auth'
import { collection, deleteDoc, doc, getFirestore, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, type Firestore, type Unsubscribe } from 'firebase/firestore'
import { validateBuilding, validateBuildingInfo, encodeCloudBuilding, decodeCloudBuilding } from './building-data.mjs'
import { validateCityObject, encodeCloudCityObject, decodeCloudCityObject } from './city-objects.mjs'
import { isLanes, type Lanes } from './lanes.mjs'

/**
 * A road edit. `way/<id>` edits one OSM way (name, asphalt). `route/<route id>` edits a whole road
 * from public/road-routes.json (e.g. `route/ref:R-303`): `ref` is its number ('' hides the shield),
 * `name` its title ('' hides the name). A route edit never carries asphalt; a way edit never carries ref.
 */
export type RoadEdit = { roadId: string; name?: string; ref?: string; asphalt?: null | Lanes; updatedAt?: number }
export type DistrictEdit = { districtId: string; name: string; updatedAt?: number }
export type Business = { id: string; name: string; lat: number; lon: number; category: string; info: string; phone: string; email: string; website: string; address: string; hours: string; menu: { id: string; name: string; price: number; currency: 'TJS'; description: string }[]; reviewsEnabled: boolean; published: boolean; updatedAt?: number }
export type Building = { id: string; name?: string; geometry: { type: 'Polygon'; coordinates: number[][][] }; source: 'admin'; height?: number; levels?: number; roof?: RoofShape; updatedAt?: number }
export type RoofShape = 'gabled' | 'hipped' | 'pyramidal'
/** Floors, a height or a roof the admin gave a shipped footprint (`ms:<index>` or `osm:way/<id>`). */
export type BuildingInfo = { key: string; levels?: number; height?: number; roof?: RoofShape; updatedAt?: number }
/** Landscaping drawn by the admin: paving and lawns, a fountain basin, a flagpole and park details. */
export type CityObject = {
  id: string; name?: string; updatedAt?: number
  width?: number; height?: number; length?: number; thickness?: number; rotation?: number; surface?: 'plain' | 'tiles' | 'asphalt'
} & (
  | { kind: 'flag' | 'monument' | 'lamp' | 'bench' | 'tree' | 'bin'; geometry: { type: 'Point'; coordinates: number[] } }
  | { kind: 'path'; geometry: { type: 'LineString'; coordinates: number[][] } }
  | { kind: 'square' | 'lawn'; geometry: { type: 'LineString'; coordinates: number[][] } | { type: 'Polygon'; coordinates: number[][][] } }
  | { kind: 'fountain'; geometry: { type: 'Polygon'; coordinates: number[][][] } })
export type CityKind = CityObject['kind']
export type Review = { id: string; businessId: string; name: string; rating: number; text: string; status: 'pending' | 'approved' | 'rejected'; createdAt: number; authorUid?: string; updatedAt?: number }
export type ReviewInput = Pick<Review, 'businessId' | 'name' | 'rating' | 'text'>
export type LiveState = { roads: Record<string, RoadEdit>; districts: Record<string, DistrictEdit>; businesses: Business[]; buildings: Building[]; buildingInfo: Record<string, BuildingInfo>; cityObjects: CityObject[]; reviews: Review[] }
export type LiveSession = { username: string; admin: boolean; uid?: string } | null
type RuntimeConfig = { firebase?: { apiKey: string; projectId: string; authDomain?: string; appId?: string; [key: string]: string | undefined }; adminUsername?: string; adminEmail?: string; adminUid?: string }
const empty = (): LiveState => ({ roads: {}, districts: {}, businesses: [], buildings: [], buildingInfo: {}, cityObjects: [], reviews: [] })
let configPromise: Promise<RuntimeConfig> | undefined
export function getRuntimeConfig() { return configPromise ??= fetch(siteUrl('/runtime-config.json'), { cache: 'no-store' }).then(async response => response.ok ? response.json() : {}).catch(() => ({})) as Promise<RuntimeConfig> }
const message = (error: unknown) => {
  const code = (error as { code?: string })?.code
  if (['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password', 'auth/user-not-found'].includes(code ?? '')) return 'Неверный логин или пароль'
  if (code === 'permission-denied') return 'Недостаточно прав. Войдите как администратор.'
  if (code === 'auth/too-many-requests') return 'Слишком много попыток. Повторите позже.'
  return error instanceof Error ? error.message : 'Не удалось подключиться к серверу'
}
const clean = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const firebaseId = (id: string) => encodeURIComponent(id)
async function api<T>(path: string, method = 'GET', input?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method, credentials: 'same-origin', cache: 'no-store', ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status})`)
  return data
}
function validName(value: string, max = 200) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Проверьте название: не используйте HTML или пустой текст'); }

export function useLiveMap(admin = false) {
  const [state, setState] = useState<LiveState>(empty), [ready, setReady] = useState(false), [connected, setConnected] = useState(false), [error, setError] = useState(''), [session, setSession] = useState<LiveSession>(null)
  const runtime = useRef<{ config: RuntimeConfig; db?: Firestore; auth?: Auth } | null>(null)
  const localReconnect = useRef<(() => Promise<void>) | null>(null)
  const stateRef = useRef(state); stateRef.current = state
  const sessionRef = useRef(session); sessionRef.current = session
  useEffect(() => {
    let cancelled = false, generation = 0, reviewGeneration = 0, eventSource: EventSource | undefined, stopAuth: Unsubscribe | undefined, stops: Unsubscribe[] = [], reviewStops: Unsubscribe[] = []
    const offline = () => setConnected(false)
    window.addEventListener('offline', offline)
    function stopFeeds() { reviewGeneration++; stops.forEach(stop => stop()); stops = []; reviewStops.forEach(stop => stop()); reviewStops = []; eventSource?.close(); eventSource = undefined }
    const fail = (cause: unknown) => { if (!cancelled) { setError(message(cause)); setConnected(false); setReady(true) } }
    const local = async () => {
      const revision = ++generation
      stopFeeds()
      const result = await api<{ session: LiveSession }>('session'); if (cancelled || revision !== generation) return
      setSession(result.session)
      const suffix = admin && result.session?.admin ? '?admin=1' : ''
      const snapshot = await api<LiveState>(`state${suffix}`); if (cancelled || revision !== generation) return
      setState(snapshot); setReady(true); setError('')
      eventSource = new EventSource(`/api/events${suffix}`)
      eventSource.addEventListener('state', event => { if (!cancelled && revision === generation) { try { setState(JSON.parse((event as MessageEvent).data)); setConnected(true); setError('') } catch { fail(new Error('Некорректный ответ сервера')) } } })
      eventSource.onopen = () => { if (!cancelled && revision === generation) setConnected(true) }
      eventSource.onerror = () => { if (!cancelled && revision === generation) { setConnected(false); setError('Соединение прервано. Переподключаемся…') } }
    }
    localReconnect.current = local
    void getRuntimeConfig().then(config => {
      if (cancelled) return
      if (!config.firebase?.apiKey || !config.firebase?.projectId) { runtime.current = { config }; return local() }
      let app: FirebaseApp = getApps().find(app => app.name === 'atlas-live') as FirebaseApp
      app ??= initializeApp(config.firebase, 'atlas-live')
      const db = getFirestore(app), auth = getAuth(app)
      runtime.current = { config, db, auth }
      stopAuth = onAuthStateChanged(auth, user => { const revision = ++generation; const current = () => !cancelled && revision === generation; void (async () => {
        const token = user && !user.isAnonymous ? await user.getIdTokenResult() : null
        if (!current()) return
        const allowed = !!user && (token?.claims.admin === true || (!!config.adminUid && user.uid === config.adminUid))
        setSession(allowed ? { username: config.adminUsername || 'CaplineGroup-map', uid: user!.uid, admin: true } : null)
        stopFeeds(); setState(empty()); setReady(false)
        let received = 0
        const seen = new Set<string>()
        const good = (key: string, fromCache: boolean) => { if (!current()) return; if (!seen.has(key)) { seen.add(key); received++ }; setConnected(!fromCache && navigator.onLine); if (!fromCache) setError(''); if (received >= 6) setReady(true) }
        const feedFail = (cause: unknown) => { if (current()) fail(cause) }
        const adminFeed = admin && allowed
        for (const [field, col, idKey] of [['roads', 'roadEdits', 'roadId'], ['districts', 'districtEdits', 'districtId'], ['buildings', 'buildingEdits', 'id'], ['buildingInfo', 'buildingInfo', 'key'], ['cityObjects', 'cityObjects', 'id']] as const) {
          stops.push(onSnapshot(collection(db, col), { includeMetadataChanges: true }, snap => { if (!current()) return; try { const docs = snap.docs.map(doc => doc.data()); const values = field === 'buildings' ? docs.map(decodeCloudBuilding) : field === 'cityObjects' ? docs.flatMap(doc => { try { return [decodeCloudCityObject(doc)] } catch { return [] } }) : Object.fromEntries(docs.map(value => [value[idKey], value])); setState(current => ({ ...current, [field]: values })); good(field, snap.metadata.fromCache) } catch (cause) { feedFail(cause) } }, feedFail))
        }
        const businessesQuery = adminFeed ? collection(db, 'businesses') : query(collection(db, 'businesses'), where('published', '==', true))
        stops.push(onSnapshot(businessesQuery, { includeMetadataChanges: true }, snap => {
          if (!current()) return
          const businesses = snap.docs.map(doc => doc.data() as Business)
          setState(current => ({ ...current, businesses })); good('businesses', snap.metadata.fromCache)
          if (!adminFeed) {
            const reviewsRevision = ++reviewGeneration
            reviewStops.forEach(stop => stop()); reviewStops = []; const reviewMap = new Map<string, Review[]>()
            setState(current => ({ ...current, reviews: [] }))
            for (const business of businesses.filter(b => b.reviewsEnabled)) reviewStops.push(onSnapshot(query(collection(db, 'reviews'), where('businessId', '==', business.id), where('status', '==', 'approved')), reviews => {
              if (!current() || reviewsRevision !== reviewGeneration) return
              reviewMap.set(business.id, reviews.docs.map(doc => { const data = doc.data(); return { ...data, createdAt: data.createdAt?.toMillis?.() ?? data.createdAt ?? Date.now() } as Review }))
              setState(current => ({ ...current, reviews: [...reviewMap.values()].flat() }))
            }, cause => { if (reviewsRevision === reviewGeneration) feedFail(cause) }))
          }
        }, feedFail))
        if (adminFeed) stops.push(onSnapshot(collection(db, 'reviews'), snap => { if (!current()) return; setState(current => ({ ...current, reviews: snap.docs.map(doc => { const data = doc.data(); return { ...data, createdAt: data.createdAt?.toMillis?.() ?? data.createdAt ?? Date.now() } as Review }) })) }, feedFail))
      })().catch(cause => { if (current()) fail(cause) }) }, fail)
    }).catch(fail)
    return () => { cancelled = true; generation++; window.removeEventListener('offline', offline); stopAuth?.(); stopFeeds(); localReconnect.current = null; runtime.current = null }
  }, [admin])
  const perform = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => { try { const result = await task(); setError(''); return result } catch (cause) { setError(message(cause)); throw new Error(message(cause)) } }, [])
  const login = useCallback((username: string, password: string) => perform(async () => {
    if (!runtime.current) throw new Error('Подключение ещё не готово')
    const { auth, config } = runtime.current
    if (auth) {
      if (username !== (config.adminUsername || 'CaplineGroup-map') || !config.adminEmail) throw new Error('Неверный логин или пароль')
      const result = await signInWithEmailAndPassword(auth, config.adminEmail, password)
      const token = await result.user.getIdTokenResult(true)
      if (token.claims.admin !== true && result.user.uid !== config.adminUid) { await signOut(auth); throw new Error('У этой учётной записи нет доступа к панели администратора') }
    } else { const result = await api<{ session: LiveSession }>('login', 'POST', { username, password }); setSession(result.session); sessionRef.current = result.session; await localReconnect.current?.() }
  }), [perform])
  const logout = useCallback(() => perform(async () => { if (runtime.current?.auth) await signOut(runtime.current.auth); else { await api('logout', 'POST', {}); setSession(null); sessionRef.current = null; await localReconnect.current?.() } }), [perform])
  const save = useCallback((endpoint: string, col: string, id: string, value: Record<string, unknown>, merge = false) => perform(async () => {
    if (!sessionRef.current?.admin) throw new Error('Войдите в панель администратора')
    if (runtime.current?.db) await setDoc(doc(runtime.current.db, col, firebaseId(id)), clean(col === 'buildingEdits' ? encodeCloudBuilding(value) : col === 'cityObjects' ? encodeCloudCityObject(value) : value), { merge })
    else await api(endpoint, 'PUT', value)
  }), [perform])
  const remove = useCallback((endpoint: string, col: string, id: string) => perform(async () => { if (!sessionRef.current?.admin) throw new Error('Войдите в панель администратора'); if (runtime.current?.db) await deleteDoc(doc(runtime.current.db, col, firebaseId(id))); else await api(endpoint, 'DELETE', { id }) }), [perform])
  const saveRoad = useCallback(async (edit: RoadEdit) => {
    const route = edit.roadId.startsWith('route/')
    if (edit.name !== undefined && !(route && edit.name === '')) validName(edit.name)
    if (edit.ref !== undefined) {
      if (!route) throw new Error('Номер можно задать только дороге')
      if (typeof edit.ref !== 'string' || edit.ref.length > 24 || /[<>\u0000-\u001f]/.test(edit.ref)) throw new Error('Проверьте номер дороги: до 24 символов, без HTML')
    }
    if (route && edit.asphalt !== undefined) throw new Error('Полосы задаются для отдельного участка улицы')
    if (edit.asphalt !== undefined && edit.asphalt !== null && !isLanes(edit.asphalt)) throw new Error('Некорректное число полос')
    await save('roads', 'roadEdits', edit.roadId, { ...edit, updatedAt: Date.now() }, true)
  }, [save])
  const deleteRoad = useCallback((roadId: string) => remove('roads', 'roadEdits', roadId), [remove])
  const saveDistrict = useCallback(async (edit: DistrictEdit) => { validName(edit.name); await save('districts', 'districtEdits', edit.districtId, { ...edit, updatedAt: Date.now() }) }, [save])
  const saveBusiness = useCallback(async (business: Business) => {
    validName(business.name); if (!Number.isFinite(business.lat) || !Number.isFinite(business.lon)) throw new Error('Укажите положение на карте')
    if (business.website && !/^https?:\/\//i.test(business.website)) throw new Error('Сайт должен начинаться с https:// или http://')
    if (!Array.isArray(business.menu) || business.menu.length > 100 || business.menu.some(item => !Number.isFinite(item.price) || item.price < 0)) throw new Error('Проверьте цены в меню')
    await save('businesses', 'businesses', business.id, { ...business, updatedAt: Date.now() })
  }, [save])
  const saveBuilding = useCallback(async (building: Building) => { const value = validateBuilding(building); await save('buildings', 'buildingEdits', value.id, value) }, [save])
  const deleteBusiness = useCallback((id: string) => remove('businesses', 'businesses', id), [remove])
  const deleteBuilding = useCallback((id: string) => remove('buildings', 'buildingEdits', id), [remove])
  const saveBuildingInfo = useCallback(async (info: BuildingInfo) => { const value = validateBuildingInfo(info); await save('building-info', 'buildingInfo', value.key, value) }, [save])
  const deleteBuildingInfo = useCallback((key: string) => remove('building-info', 'buildingInfo', key), [remove])
  const saveCityObject = useCallback(async (object: CityObject) => { const value = validateCityObject(object); await save('city-objects', 'cityObjects', value.id, value) }, [save])
  const deleteCityObject = useCallback((id: string) => remove('city-objects', 'cityObjects', id), [remove])
  const submitReview = useCallback((input: ReviewInput) => perform(async () => {
    validName(input.name, 100); validName(input.text, 2000)
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new Error('Выберите оценку от 1 до 5')
    if (!stateRef.current.businesses.some(b => b.id === input.businessId && b.published && b.reviewsEnabled)) throw new Error('Отзывы для этого места отключены')
    if (runtime.current?.db && runtime.current.auth) {
      const { db, auth } = runtime.current
      const user = auth.currentUser ?? (await signInAnonymously(auth)).user
      const ref = doc(collection(db, 'reviews'))
      await setDoc(ref, { ...clean(input), id: ref.id, status: 'pending', createdAt: serverTimestamp(), authorUid: user.uid })
    } else await api('reviews', 'POST', input)
  }), [perform])
  const moderateReview = useCallback((id: string, status: Review['status']) => perform(async () => { if (!sessionRef.current?.admin) throw new Error('Войдите в панель администратора'); if (!['pending', 'approved', 'rejected'].includes(status)) throw new Error('Некорректный статус'); if (runtime.current?.db) await updateDoc(doc(runtime.current.db, 'reviews', firebaseId(id)), { status, updatedAt: Date.now() }); else await api('reviews/moderate', 'PUT', { id, status }) }), [perform])
  return { state, ready, connected, error, session, login, logout, saveRoad, deleteRoad, saveDistrict, saveBusiness, deleteBusiness, saveBuilding, deleteBuilding, saveBuildingInfo, deleteBuildingInfo, saveCityObject, deleteCityObject, submitReview, moderateReview }
}

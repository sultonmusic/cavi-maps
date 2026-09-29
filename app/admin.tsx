import {siteUrl} from '@/lib/site-url';
import {useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent} from 'react';
import {Armchair, ArrowLeft, Building2, Check, ChevronLeft, Download, Droplets, Eye, Flag, Footprints, Lamp, Landmark, Layers, LocateFixed, LogOut, MapPin, MessageSquare, Minus, Mountain, MousePointer2, Pencil, Plus, Search, ShieldCheck, Sprout, Square, Store, Trash2, TreeDeciduous, Trees, Undo2, X} from 'lucide-react';
import {useLiveMap, type Business, type Building, type CityKind, type CityObject} from '../lib/live-store';
import {createAtlasGL, composeLabels, baseLabels, wallHeight, roofFits, type AtlasGL, type AtlasLabel, type BuildingData,
  type EditorShape, type OsmBuilding, type RoofShape, type SelectionGeometry} from '../lib/atlas-gl';
import type {Marker} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {createStreetIndex, roadPoint, type Road} from '../lib/street-index';
import {districtAt, type District} from '../lib/map-places';
import {CITY_SIZES, isNarrowOutline, type SizeKey} from '../lib/city-objects.mjs';
import {isLanes, isOneway, type Lanes} from '../lib/lanes.mjs';
import './admin.css';

type Tab = 'roads' | 'districts' | 'businesses' | 'buildings' | 'city' | 'reviews';
type Selection = {kind: 'road' | 'district' | 'business' | 'building' | 'footprint' | 'city'; id: string} | null;
/** A shipped footprint being given floors and a roof; the inputs stay text until they are saved. */
type Footprint = {key: string; levels: string; height: string; roof: RoofShape | ''};
const ROOFS = [['', 'Плоская'], ['gabled', 'Двускатная'], ['hipped', 'Вальмовая, 4 ската'], ['pyramidal', 'Шатровая']] as const;
const roofTitle = (roof?: string) => ROOFS.find(([value]) => value === (roof ?? ''))?.[1] ?? 'Плоская';
type PickMode = 'select' | 'business' | 'building' | 'city' | 'point' | 'centre';
/** How a square, lawn or fountain is made: by its corners, as a sized rectangle or circle, or as a strip. */
type AreaShape = 'outline' | 'rectangle' | 'circle' | 'strip';
type AreaSize = {width: number; length: number; diameter: number; rotation: number};
const AREA_SHAPES: readonly [AreaShape, string][] = [['outline', 'По углам'], ['rectangle', 'Прямоугольник'], ['circle', 'Круг'], ['strip', 'Полоса']];
const FOUNTAIN_SHAPES: readonly [AreaShape, string][] = [['outline', 'По углам'], ['circle', 'Восьмиугольник'], ['rectangle', 'Прямоугольник']];
const NARROW = 'Точки лежат почти на одной линии, поэтому у фигуры нет ширины. Отметьте углы вокруг участка или выберите «Прямоугольник», «Круг» или «Полосу».';

/** A rectangle or a regular polygon around a centre, as a closed ring of [lon, lat]. Sizes are in
    metres; rotation turns the length clockwise from north. */
function shapeAround([lon, lat]: [number, number], shape: 'rectangle' | 'circle', size: AreaSize, corners: number): number[][] {
  const east = 111320 * Math.cos(lat * Math.PI / 180), north = 110540, angle = size.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const local = shape === 'rectangle'
    ? [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => [x * size.width / 2, y * size.length / 2])
    : Array.from({length: corners}, (_, i) => [Math.cos(i / corners * Math.PI * 2) * size.diameter / 2, Math.sin(i / corners * Math.PI * 2) * size.diameter / 2]);
  const ring = local.map(([x, y]) => [lon + (x * cos + y * sin) / east, lat + (y * cos - x * sin) / north]);
  return [...ring, ring[0]];
}
const TABS = [
  {id: 'roads', title: 'Улицы', icon: MousePointer2},
  {id: 'districts', title: 'Районы', icon: Layers},
  {id: 'businesses', title: 'Организации', icon: Store},
  {id: 'buildings', title: 'Здания', icon: Building2},
  {id: 'city', title: 'Благоустройство', icon: Trees},
  {id: 'reviews', title: 'Отзывы', icon: MessageSquare},
] as const;
const categories = [['food','Еда'],['shop','Магазин'],['hotel','Отель'],['health','Здоровье'],['fuel','АЗС'],['tourism','Достопримечательность'],['service','Услуги'],['other','Другое']];
const collator = new Intl.Collator('ru', {numeric: true});
const message = (value: unknown) => value instanceof Error ? value.message : 'Не удалось сохранить изменения';
const id = () => globalThis.crypto?.randomUUID?.() || `atlas-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const newBusiness = (): Business => ({id:id(), name:'', lat:40.6602, lon:70.3597, category:'other', info:'', phone:'', email:'', website:'', address:'', hours:'', menu:[], reviewsEnabled:true, published:false});
const newBuilding = (): Building => ({id:id(), name:'', source:'admin', geometry:{type:'Polygon', coordinates:[]}});
const CITY_GROUPS = ['Покрытия', 'Сооружения', 'Детали'] as const;
type CityField = {key: SizeKey; label: string; step: number};
const ROTATION: CityField = {key: 'rotation', label: 'Направление, °', step: 5};
/* Everything the landscaping editor can place. A size carries only its label and step here:
   limits and defaults come from the shared validator, so the form and the database agree. */
const CITY_KINDS: readonly {kind: CityKind; group: typeof CITY_GROUPS[number]; title: string; icon: typeof Flag; hint: string; fields: readonly CityField[]}[] = [
  {kind: 'path', group: 'Покрытия', title: 'Дорожка', icon: Footprints, hint: 'Отметьте дорожку от начала до конца', fields: [{key: 'width', label: 'Ширина, м', step: 0.5}]},
  {kind: 'square', group: 'Покрытия', title: 'Площадь', icon: Square, hint: 'Отметьте углы площади по порядку', fields: []},
  {kind: 'lawn', group: 'Покрытия', title: 'Газон', icon: Sprout, hint: 'Отметьте края газона по порядку', fields: []},
  {kind: 'fountain', group: 'Сооружения', title: 'Фонтан', icon: Droplets, hint: 'Отметьте углы чаши по порядку, например 8 углов', fields: []},
  {kind: 'flag', group: 'Сооружения', title: 'Флагшток', icon: Flag, hint: 'Отметьте место флагштока', fields: [{key: 'height', label: 'Высота, м', step: 0.5}, {key: 'thickness', label: 'Толщина столба, м', step: 0.05}, {key: 'length', label: 'Длина флага, м', step: 0.5}, ROTATION]},
  {kind: 'monument', group: 'Сооружения', title: 'Памятник', icon: Landmark, hint: 'Отметьте место памятника', fields: [{key: 'height', label: 'Высота, м', step: 0.5}, {key: 'width', label: 'Ширина постамента, м', step: 0.1}, ROTATION]},
  {kind: 'lamp', group: 'Детали', title: 'Фонарь', icon: Lamp, hint: 'Отметьте место фонаря', fields: [{key: 'height', label: 'Высота, м', step: 0.5}, ROTATION]},
  {kind: 'bench', group: 'Детали', title: 'Скамейка', icon: Armchair, hint: 'Отметьте место скамейки', fields: [{key: 'length', label: 'Длина, м', step: 0.1}, ROTATION]},
  {kind: 'tree', group: 'Детали', title: 'Дерево', icon: TreeDeciduous, hint: 'Отметьте место дерева', fields: [{key: 'height', label: 'Высота, м', step: 0.5}, {key: 'width', label: 'Ширина кроны, м', step: 0.5}]},
  {kind: 'bin', group: 'Детали', title: 'Урна', icon: Trash2, hint: 'Отметьте место урны', fields: []},
];
const SURFACE_OPTIONS = [['tiles', 'Плитка'], ['plain', 'Без плитки'], ['asphalt', 'Асфальт']] as const;
const formatPoint = ([lon, lat]: number[]) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
const cityKind = (kind: CityKind) => CITY_KINDS.find(item => item.kind === kind)!;
type PointObject = Extract<CityObject, {geometry: {type: 'Point'}}>;
const isPointObject = (value: CityObject): value is PointObject => value.geometry.type === 'Point';
const newCityObject = (kind: CityKind): CityObject => {
  if (kind === 'path') return {id: id(), kind, name: '', width: 3, surface: 'tiles', geometry: {type: 'LineString', coordinates: []}};
  if (kind === 'square' || kind === 'lawn' || kind === 'fountain') return {id: id(), kind, name: '', ...(kind === 'square' ? {surface: 'tiles' as const} : {}), geometry: {type: 'Polygon', coordinates: []}};
  return {id: id(), kind, name: '', geometry: {type: 'Point', coordinates: []}};
};

/** "40.66575, 70.35712" in either order, with dots or commas. Across Tajikistan latitude is
    always the smaller number, so the order never has to be guessed. Returns [lon, lat]. */
function parseCoordinates(text: string): [number, number] | null {
  const numbers = (text.match(/-?\d+(?:[.,]\d+)?/g) || []).map(value => Number(value.replace(',', '.')));
  if (numbers.length !== 2 || numbers.some(value => !Number.isFinite(value))) return null;
  const lat = numbers.find(value => value >= 35.5 && value <= 42), lon = numbers.find(value => value >= 66 && value <= 76.5);
  return lat !== undefined && lon !== undefined ? [lon, lat] : null;
}

/** Type or paste a coordinate instead of tapping the map. */
function CoordinateEntry({action, onPoint, onError}: {action: string; onPoint: (point: [number, number]) => void; onError: (message: string) => void}) {
  const [text, setText] = useState('');
  function submit() {
    const point = parseCoordinates(text);
    if (!point) { onError('Не удалось распознать координаты. Пример: 40.66575, 70.35712'); return; }
    onPoint(point);
    setText('');
  }
  return <div className="admin-coordinates">
    <label>Координаты · широта, долгота<input inputMode="decimal" placeholder="40.66575, 70.35712" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }}/></label>
    <button type="button" className="admin-button" disabled={!text.trim()} onClick={submit}><MapPin size={16}/>{action}</button>
  </div>;
}

/** A walkway straight from one coordinate to another; bends can be added on the map afterwards. */
function RouteEntry({onRoute, onError}: {onRoute: (start: [number, number], end: [number, number]) => void; onError: (message: string) => void}) {
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  function submit() {
    const start = parseCoordinates(from), end = parseCoordinates(to);
    if (!start || !end) { onError(`Не удалось распознать ${start ? 'конец' : 'начало'} дорожки. Пример: 40.66575, 70.35712`); return; }
    onRoute(start, end);
    setFrom('');
    setTo('');
  }
  const enter = (event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } };
  return <div className="admin-route-entry">
    <label>Откуда · широта, долгота<input inputMode="decimal" placeholder="40.66560, 70.35700" value={from} onChange={event => setFrom(event.target.value)} onKeyDown={enter}/></label>
    <label>Куда · широта, долгота<input inputMode="decimal" placeholder="40.66590, 70.35740" value={to} onChange={event => setTo(event.target.value)} onKeyDown={enter}/></label>
    <button type="button" className="admin-button" disabled={!from.trim() || !to.trim()} onClick={submit}><Footprints size={16}/>Провести дорожку</button>
  </div>;
}
const roadTitle = (road: Road) => road.name || road.ref || 'Безымянный проезд';
const localRoad = (road: Road) => road.bbox[0] <= 70.386 && road.bbox[2] >= 70.335 && road.bbox[1] <= 40.68 && road.bbox[3] >= 40.638;
export function publicMapURL(hostname:string) {
  if(hostname==='capline-tj-map-admin.web.app')return 'https://capline-tj-map.web.app';
  if(hostname==='capline-tj-map-admin.firebaseapp.com')return 'https://capline-tj-map.firebaseapp.com';
  return '/';
}

/** Lane arrows for a choice: both ways for a two-way street, one way for a one-way carriageway. */
function LanePreview({lanes, oneway}: {lanes: string; oneway: boolean}) {
  const count = Number(lanes);
  const arrows = lanes === 'original' ? ['↑', '↓'] : count === 0 ? ['↕'] : [...Array<string>(count).fill('↑'), ...Array<string>(oneway ? 0 : count).fill('↓')];
  return <span className={`admin-lanes admin-lanes-${lanes}${arrows.length > 4 ? ' admin-lanes-many' : ''}`} aria-hidden="true">{arrows.map((arrow, index) => <span key={index}>{arrow}</span>)}</span>;
}
const laneWord = (count: number) => count === 1 ? 'полоса' : count < 5 ? 'полосы' : 'полос';

export default function Admin() {
  const publicURL = publicMapURL(typeof location==='undefined'?'':location.hostname);
  const live = useLiveMap(true);
  const [username,setUsername] = useState('CaplineGroup-map');
  const [password,setPassword] = useState('');
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [problem,setProblem] = useState('');
  const [tab,setTab] = useState<Tab>('roads');
  const [query,setQuery] = useState('');
  const [allCountry,setAllCountry] = useState(false);
  const [baseRoads,setBaseRoads] = useState<Road[]>([]);
  const [baseDistricts,setBaseDistricts] = useState<District[]>([]);
  const [buildingData,setBuildingData] = useState<BuildingData|null>(null);
  const [mapReady,setMapReady] = useState(false);
  const [selection,setSelection] = useState<Selection>(null);
  const [editName,setEditName] = useState('');
  const [asphalt,setAsphalt] = useState('original');
  const [wholeStreet,setWholeStreet] = useState(true);
  const [business,setBusiness] = useState<Business|null>(null);
  const [building,setBuilding] = useState<Building|null>(null);
  const [footprint,setFootprint] = useState<Footprint|null>(null);
  const [osmBuildings,setOsmBuildings] = useState<OsmBuilding[]>([]);
  const [cityObject,setCityObject] = useState<CityObject|null>(null);
  const [areaShape,setAreaShape] = useState<AreaShape>('outline');
  const [areaSize,setAreaSize] = useState<AreaSize>({width:6,length:10,diameter:6,rotation:0});
  const [areaCentre,setAreaCentre] = useState<[number,number]|null>(null);
  const [vertices,setVertices] = useState<number[][]>([]);
  const [pickMode,setPickMode] = useState<PickMode>('select');
  const [deleteConfirm,setDeleteConfirm] = useState(false);
  const [reviewFilter,setReviewFilter] = useState('pending');
  const [dismissedError,setDismissedError] = useState('');
  const mapNode = useRef<HTMLDivElement>(null);
  const atlas = useRef<AtlasGL|null>(null);
  const businessMarker = useRef<Marker|null>(null);
  const handles = useRef<Marker[]>([]);
  const [shippedLabels,setShippedLabels] = useState<AtlasLabel[]>([]);
  const clickHandler = useRef<(event:any)=>void>(()=>{});
  const userId = live.session?.uid || live.session?.username || '';
  const roads = useMemo(() => baseRoads.map(road => ({...road, name:live.state.roads[road.id]?.name ?? road.name})), [baseRoads,live.state.roads]);
  const districts = useMemo(() => baseDistricts.map(district => ({...district,name:live.state.districts[district.id]?.name ?? district.name})), [baseDistricts,live.state.districts]);
  const index = useMemo(() => createStreetIndex(roads),[roads]);
  const selectedRoad = selection?.kind === 'road' ? index.byId.get(selection.id) : undefined;
  const groupRoads = selectedRoad?.groupId ? roads.filter(road=>road.groupId===selectedRoad.groupId) : selectedRoad ? [selectedRoad] : [];
  const filteredRoads = useMemo(() => roads.filter(road => (allCountry || localRoad(road)) && `${roadTitle(road)} ${road.ref || ''}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).sort((a,b)=>collator.compare(roadTitle(a),roadTitle(b))),[roads,query,allCountry]);
  const pending = live.state.reviews.filter(review=>review.status==='pending').length;
  const visibleError = problem || (live.error===dismissedError?'':live.error);

  async function perform(action:()=>Promise<void>, success:string) {
    if(busy)return;
    if(live.session?.admin && success && !live.connected){setProblem('Нет соединения с сервером. Дождитесь подключения и сохраните изменения.');return}
    setBusy(true);setProblem('');setNotice('');setDismissedError('');
    try {await action();setNotice(success);setDeleteConfirm(false)} catch(error) {setProblem(message(error))} finally {setBusy(false)}
  }
  function resetEditor() {setSelection(null);setBusiness(null);setBuilding(null);setFootprint(null);setCityObject(null);setAreaShape('outline');setAreaCentre(null);setVertices([]);setPickMode('select');setDeleteConfirm(false);setProblem('');setNotice('')}
  function switchTab(next:Tab) {setTab(next);setQuery('');resetEditor()}
  function panTo(lat:number,lon:number,zoom=17) {const gl=atlas.current;if(gl)gl.map.easeTo({center:[lon,lat],zoom:Math.max(gl.map.getZoom(),zoom),duration:400})}
  function selectRoad(road:Road,pan=true) {
    resetEditor();setSelection({kind:'road',id:road.id});setEditName(roadTitle(road));setAsphalt(live.state.roads[road.id]?.asphalt == null ? 'original' : String(live.state.roads[road.id].asphalt));setWholeStreet(true);
    if(pan){const point=roadPoint(road);if(point)panTo(point.lat,point.lon)}
  }
  function selectDistrict(district:District,pan=true) {resetEditor();setSelection({kind:'district',id:district.id});setEditName(district.name);if(pan)atlas.current?.fit([[district.bbox[0],district.bbox[1]],[district.bbox[2],district.bbox[3]]],{top:40,bottom:40,left:40,right:40},17)}
  function selectBusiness(value:Business,pan=true) {resetEditor();setSelection({kind:'business',id:value.id});setBusiness({...value,menu:value.menu.map(item=>({...item}))});if(pan)panTo(value.lat,value.lon)}
  function selectBuilding(value:Building,pan=true) {resetEditor();setSelection({kind:'building',id:value.id});setBuilding({...value,geometry:{...value.geometry,coordinates:value.geometry.coordinates.map(ring=>ring.map(point=>[...point]))}});if(pan)atlas.current?.fit(value.geometry.coordinates[0],{top:50,bottom:50,left:50,right:50},19)}
  /** What a shipped footprint is called in the editor: its OSM name or its Atlas house number. */
  function footprintTitle(key:string) {
    if(key.startsWith('osm:'))return {title:osmBuildings.find(item=>`osm:${item.id}`===key)?.name||'Здание OpenStreetMap',source:'Контур OpenStreetMap · ODbL'};
    const index=Number(key.slice(3)),number=buildingData?.number?.[index],slot=buildingData?.street?.[index]??-1,street=slot>=0?buildingData?.streets?.[slot]:undefined;
    return {title:number?(street?`${street}, дом ${number}`:`Дом ${number}`):'Здание без номера',source:'Контур Microsoft · ODbL'};
  }
  function selectFootprint(key:string,pan=true) {
    resetEditor();const info=live.state.buildingInfo[key];
    setSelection({kind:'footprint',id:key});setFootprint({key,levels:info?.levels?String(info.levels):'',height:info?.height?String(info.height):'',roof:info?.roof??''});
    const ring=atlas.current?.houseRing(key);if(pan&&ring)atlas.current?.fit(ring,{top:60,bottom:60,left:60,right:60},19);
  }
  function selectCityObject(value:CityObject,pan=true) {
    resetEditor();setSelection({kind:'city',id:value.id});setCityObject(structuredClone(value));
    setAreaShape(value.kind!=='path'&&value.geometry.type==='LineString'?'strip':'outline');
    const points=value.geometry.type==='Point'?(value.geometry.coordinates.length?[value.geometry.coordinates]:[]):value.geometry.type==='LineString'?value.geometry.coordinates:value.geometry.coordinates[0]??[];
    if(pan&&points.length)atlas.current?.fit(points,{top:60,bottom:60,left:60,right:60},19);
  }
  /** Place a new object on the map, or redraw the one being edited. */
  function drawCityObject(value:CityObject) {
    if(value.geometry.type==='Point'){setPickMode('point');return}
    setVertices((value.geometry.type==='LineString'?value.geometry.coordinates:(value.geometry.coordinates[0]||[]).slice(0,-1)).map(point=>[...point]));
    setPickMode('city');
  }
  function finishCityShape() {
    if(!cityObject)return;
    if(cityObject.kind==='path'||((cityObject.kind==='square'||cityObject.kind==='lawn')&&areaShape==='strip')){
      if(vertices.length<2)return;setCityObject({...cityObject,geometry:{type:'LineString',coordinates:vertices}});
    }
    else if(cityObject.kind==='square'||cityObject.kind==='lawn'||cityObject.kind==='fountain'){
      if(vertices.length<3)return;
      if(isNarrowOutline(vertices)){setProblem(NARROW);return}
      setCityObject({...cityObject,geometry:{type:'Polygon',coordinates:[[...vertices,vertices[0]]]}});
    }
    setPickMode('select');setProblem('');setNotice('Готово. Сохраните объект.');
  }
  /** Switch how an area is made; the outline drawn so far belongs to the old way, so it is cleared. */
  function chooseAreaShape(shape:AreaShape) {
    if(!cityObject||(cityObject.kind!=='square'&&cityObject.kind!=='lawn'&&cityObject.kind!=='fountain'))return;
    setAreaShape(shape);setAreaCentre(null);setVertices([]);setPickMode('select');setProblem('');
    if(shape==='strip'&&cityObject.kind!=='fountain')setCityObject({...cityObject,geometry:{type:'LineString',coordinates:[]}});
    else setCityObject({...cityObject,geometry:{type:'Polygon',coordinates:[]}});
  }
  /** Rebuild a rectangle or circle from its centre and sizes; the saved object keeps only the outline. */
  function buildArea(centre:[number,number]|null,shape:AreaShape,size:AreaSize) {
    setAreaCentre(centre);setAreaSize(size);
    if(!centre||!cityObject||(shape!=='rectangle'&&shape!=='circle')||size.width<=0||size.length<=0||size.diameter<=0)return;
    if(cityObject.kind!=='square'&&cityObject.kind!=='lawn'&&cityObject.kind!=='fountain')return;
    setCityObject({...cityObject,geometry:{type:'Polygon',coordinates:[shapeAround(centre,shape,size,cityObject.kind==='fountain'?8:48)]}});
  }

  useEffect(()=>{
    if(!userId)return;
    let cancelled=false;
    fetch(siteUrl('/shaydon-buildings.json')).then(r=>r.ok?r.json():null).then(data=>{if(!cancelled&&data)setBuildingData(data)}).catch(()=>{});
    fetch(siteUrl('/shaydon-osm-buildings.json')).then(r=>r.ok?r.json():null).then(data=>{if(!cancelled&&data)setOsmBuildings(data.buildings)}).catch(()=>{});
    Promise.all([fetch(siteUrl('/streets.json')).then(r=>{if(!r.ok)throw Error('Не удалось загрузить улицы');return r.json()}),fetch(siteUrl('/districts.json')).then(r=>{if(!r.ok)throw Error('Не удалось загрузить микрорайоны');return r.json()})]).then(([streets,areas])=>{if(!cancelled){setBaseRoads(streets.roads);setBaseDistricts(areas.districts)}}).catch(error=>{if(!cancelled)setProblem(message(error))});
    baseLabels().then(list=>{if(!cancelled)setShippedLabels(list)}).catch(()=>{});
    if(mapNode.current){
      const instance=createAtlasGL(mapNode.current,error=>{if(!cancelled)setProblem(error)});
      atlas.current=instance;
      instance.map.on('click',(event)=>clickHandler.current(event));
      setMapReady(true);
    }
    return ()=>{cancelled=true;businessMarker.current?.remove();handles.current.forEach(handle=>handle.remove());
      handles.current=[];atlas.current?.destroy();atlas.current=null;setMapReady(false)};
  },[userId]);

  useEffect(()=>{if(buildingData)atlas.current?.setBuildings(buildingData)},[buildingData]);
  useEffect(()=>{atlas.current?.setOsmBuildings(osmBuildings)},[osmBuildings,mapReady]);
  useEffect(()=>{atlas.current?.setBuildingInfo(live.state.buildingInfo)},[live.state.buildingInfo,mapReady]);
  useEffect(()=>{atlas.current?.setCityObjects(live.state.cityObjects)},[live.state.cityObjects,mapReady]);
  const roadNames = useMemo(()=>Object.fromEntries(Object.values(live.state.roads)
    .filter(edit=>edit.name?.trim()).map(edit=>[edit.roadId,edit.name!.trim()])),[live.state.roads]);
  const districtNames = useMemo(()=>Object.fromEntries(Object.values(live.state.districts)
    .filter(edit=>edit.name?.trim()).map(edit=>[edit.districtId,edit.name.trim()])),[live.state.districts]);
  const pavedRoads = useMemo(()=>Object.values(live.state.roads)
    .filter(edit=>isLanes(edit.asphalt))
    .map(edit=>{const road=baseRoads.find(item=>item.id===edit.roadId);return {id:edit.roadId,asphalt:edit.asphalt as Lanes,oneway:isOneway(road?.tags),coordinates:road?.coordinates??[]}})
    .filter(road=>road.coordinates.length>1),[live.state.roads,baseRoads]);
  useEffect(()=>{atlas.current?.setLabels(composeLabels(shippedLabels,{roads:baseRoads,districts:baseDistricts,
    roadNames,districtNames,buildings:live.state.buildings}))},
    [shippedLabels,baseRoads,baseDistricts,roadNames,districtNames,live.state.buildings]);
  useEffect(()=>{atlas.current?.setLiveRoads(pavedRoads)},[pavedRoads]);
  useEffect(()=>{atlas.current?.setAdminBuildings(live.state.buildings)},[live.state.buildings]);

  clickHandler.current = event => {
    const gl=atlas.current;if(!gl)return;
    const {lat,lng:lon}=event.lngLat;
    if(pickMode==='business' && business){setBusiness({...business,lat,lon});setPickMode('select');setNotice('Точка организации выбрана. Сохраните карточку.');return}
    if(pickMode==='building'||pickMode==='city'){setVertices(previous=>[...previous,[lon,lat]]);return}
    if(pickMode==='centre'){buildArea([lon,lat],areaShape,areaSize);setPickMode('select');setNotice('Центр выбран. Размеры можно менять — фигура перестроится.');return}
    if(pickMode==='point'&&cityObject&&isPointObject(cityObject)){setCityObject({...cityObject,geometry:{type:'Point',coordinates:[lon,lat]}});setPickMode('select');setNotice('Место выбрано. Проверьте размеры и сохраните.');return}
    // In a tilted view the finger lands on a building's walls or roof, not on its outline on the ground,
    // so on the buildings tab the building is found along the line of sight before any outline drawn on the ground.
    if(tab==='buildings'){
      const seen=gl.houseAt(event.point);
      if(seen?.source==='admin'){const value=live.state.buildings.find(item=>`admin:${item.id}`===seen.key);if(value){selectBuilding(value,false);return}}
      if(seen?.source==='houses'){selectFootprint(seen.key,false);return}
      if(seen){setNotice(seen.source==='landmark'?'Это здание смоделировано отдельно и здесь не редактируется.':'Этажность пока можно указать только для зданий Шайдона.');return}
    }
    // An object drawn by the editor wins over whatever lies under it.
    const layers=['editor-point','editor-line','editor-fill'].filter(id=>gl.map.getLayer(id));
    // A few pixels of slack, so a thin walkway line can be picked with a finger.
    const box:[[number,number],[number,number]]=[[event.point.x-8,event.point.y-8],[event.point.x+8,event.point.y+8]];
    const hit=layers.length?gl.map.queryRenderedFeatures(box,{layers})[0]:undefined;
    if(hit){
      const role=hit.properties?.role,id=String(hit.properties?.id??'');
      if(role==='business'){const value=live.state.businesses.find(item=>item.id===id);if(value){selectBusiness(value,false);return}}
      if(role==='district'){const area=districts.find(item=>item.id===id);if(area){selectDistrict(area,false);return}}
      if(role==='building'){const value=live.state.buildings.find(item=>item.id===id);if(value){selectBuilding(value,false);return}}
      if(role==='city'){const value=live.state.cityObjects.find(item=>item.id===id);if(value){selectCityObject(value,false);return}}
    }
    if(tab==='buildings'){setNotice('Нажмите на здание, чтобы указать этажность, или нарисуйте новое кнопкой «+».');return}
    if(tab==='city'){setNotice('Выберите объект на карте или добавьте новый кнопками в списке.');return}
    if(tab==='roads') {
      const radius=Math.max(10,Math.min(65,156543.03*Math.cos(lat*Math.PI/180)/2**gl.map.getZoom()*18));
      const match=index.nearest(lat,lon,radius);
      if(match)selectRoad(match.road,false);else setNotice('Приблизьте карту и нажмите непосредственно на улицу.');
    } else if(tab==='districts') {const area=districtAt(districts,lat,lon);if(area)selectDistrict(area,false);else setNotice('Здесь пока нет границы микрорайона. Выберите район из списка.')}
  };

  useEffect(()=>{
    const shapes:EditorShape[]=[];
    if(tab==='businesses')for(const value of live.state.businesses)shapes.push({type:'Feature',
      properties:{role:'business',id:value.id,published:value.published},
      geometry:{type:'Point',coordinates:[value.lon,value.lat]}});
    if(tab==='districts')for(const district of districts)shapes.push({type:'Feature',
      properties:{role:'district',id:district.id},geometry:district.geometry as EditorShape['geometry']});
    if(tab==='buildings')for(const value of live.state.buildings)shapes.push({type:'Feature',
      properties:{role:'building',id:value.id},geometry:value.geometry as EditorShape['geometry']});
    if(tab==='city')for(const value of live.state.cityObjects)shapes.push({type:'Feature',
      properties:{role:'city',id:value.id},geometry:value.geometry as EditorShape['geometry']});
    atlas.current?.setEditorShapes(shapes);
  },[mapReady,tab,districts,live.state.businesses,live.state.buildings,live.state.cityObjects]);

  useEffect(()=>{
    const gl=atlas.current;if(!gl)return;
    let shape:SelectionGeometry|null=null;
    if(selection?.kind==='road' && selectedRoad){
      const chosen=wholeStreet?groupRoads:[selectedRoad];
      shape={type:'MultiLineString',coordinates:chosen.map(road=>road.coordinates)};
    }
    if(selection?.kind==='district'){const area=districts.find(value=>value.id===selection.id);
      if(area)shape=area.geometry as SelectionGeometry}
    if(footprint){const ring=gl.houseRing(footprint.key);if(ring)shape={type:'Polygon',coordinates:[ring]}}
    if(building && pickMode!=='building' && building.geometry.coordinates.length)
      shape={type:'Polygon',coordinates:building.geometry.coordinates};
    if(cityObject && pickMode==='select' && cityObject.geometry.type!=='Point' && cityObject.geometry.coordinates.length)
      shape=cityObject.geometry as SelectionGeometry;
    if(pickMode==='city' && vertices.length>1)
      shape=cityObject?.kind!=='path'&&areaShape!=='strip'&&vertices.length>2?{type:'Polygon',coordinates:[[...vertices,vertices[0]]]}:{type:'LineString',coordinates:vertices};
    if(pickMode==='building' && vertices.length>1)
      shape=vertices.length>2?{type:'Polygon',coordinates:[[...vertices,vertices[0]]]}:{type:'LineString',coordinates:vertices};
    gl.setSelection(shape);

    businessMarker.current?.remove();businessMarker.current=null;
    if(business){businessMarker.current=gl.marker('<span class="admin-point"></span>','admin-point-wrap','center')
      .setLngLat([business.lon,business.lat]).addTo(gl.map)}
    else if(cityObject?.geometry.type==='Point'&&cityObject.geometry.coordinates.length===2){businessMarker.current=gl.marker('<span class="admin-point"></span>','admin-point-wrap','center')
      .setLngLat(cityObject.geometry.coordinates as [number,number]).addTo(gl.map)}

    // One draggable handle per corner while the outline is being drawn.
    handles.current.forEach(handle=>handle.remove());handles.current=[];
    if(pickMode==='building'||pickMode==='city')vertices.forEach((point,index)=>{
      const handle=gl.vertex(point[0],point[1],(lon,lat)=>
        setVertices(previous=>previous.map((current,i)=>i===index?[lon,lat]:current)));
      handle.addTo(gl.map);handles.current.push(handle);
    });
  },[mapReady,selection,selectedRoad,roads,districts,wholeStreet,business,building,footprint,cityObject,areaShape,vertices,pickMode,groupRoads]);

  async function saveStreet(event:FormEvent) {
    event.preventDefault();if(!selectedRoad)return;
    await perform(async()=>{for(const road of wholeStreet?groupRoads:[selectedRoad])await live.saveRoad({roadId:road.id,name:editName.trim(),asphalt:asphalt==='original'?null:Number(asphalt) as Lanes})},'Улица сохранена. Карта пользователей обновляется автоматически.');
  }
  function finishOutline() {
    if(!building || vertices.length<3)return;
    setBuilding({...building,geometry:{type:'Polygon',coordinates:[[...vertices,vertices[0]]]}});setPickMode('select');setNotice('Контур готов. Укажите название и сохраните здание.');
  }
  function downloadEdits() {
    const url=URL.createObjectURL(new Blob([JSON.stringify({exportedAt:new Date().toISOString(),...live.state},null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`atlas-edits-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function deleteButtons(remove:()=>Promise<void>, label:string) {
    return !deleteConfirm ? <button type="button" className="admin-button danger subtle" disabled={busy} onClick={()=>setDeleteConfirm(true)}><Trash2 size={16}/>Удалить {label}</button> : <div className="admin-delete-confirm"><p>Удалить {label} с карты? Действие нельзя отменить.</p><div className="admin-row"><button type="button" className="admin-button danger" disabled={busy} onClick={()=>perform(async()=>{await remove();resetEditor()},'Объект удалён с карты')}>Да, удалить</button><button type="button" className="admin-button" onClick={()=>setDeleteConfirm(false)}>Отмена</button></div></div>;
  }

  if(!live.session?.admin)return <main className="admin-login admin-root"><a href={publicURL} className="admin-back-link"><ArrowLeft size={17}/>Открыть карту</a><form className="admin-login-card" onSubmit={event=>{event.preventDefault();perform(async()=>{await live.login(username.trim(),password);setPassword('')},'')}}><span className="admin-login-icon"><Mountain size={29}/></span><span className="admin-eyebrow">ATLAS · ТАДЖИКИСТАН</span><h1>Управление картой</h1><p>Улицы, здания и организации в одном месте.</p><label>Логин<input name="username" autoComplete="username" value={username} onChange={event=>setUsername(event.target.value)} required maxLength={80}/></label><label>Пароль<input name="password" type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required maxLength={128}/></label>{(problem||live.error)&&<p className="admin-message is-error" role="alert">{problem||live.error}</p>}<button className="admin-button primary" disabled={busy||!live.ready}>{busy?'Входим…':!live.ready?'Подключение…':'Войти'}<ShieldCheck size={18}/></button><small>Доступ только для администратора.</small></form></main>;

  return <main className="admin-root admin-app">
    <header className="admin-header"><a href={publicURL} className="admin-logo"><span><Mountain size={24}/></span><div>atlas<span>.</span><small>УПРАВЛЕНИЕ КАРТОЙ</small></div></a><div className={`admin-connection ${live.connected?'':'is-offline'}`}><i/>{live.connected?'Изменения онлайн':'Соединение…'}</div><div className="admin-header-actions"><a className="admin-button" href={publicURL} target="_blank" rel="noreferrer"><Eye size={17}/><span>Карта</span></a><button className="admin-button" onClick={downloadEdits} title="Скачать изменения в JSON"><Download size={17}/><span>Экспорт</span></button><button className="admin-button" onClick={()=>perform(()=>live.logout(),'')} disabled={busy} title="Выйти"><LogOut size={17}/><span>Выйти</span></button></div></header>
    <nav className="admin-tabs" aria-label="Разделы управления">{TABS.map(({id,title,icon:Icon})=><button key={id} className={tab===id?'active':''} onClick={()=>switchTab(id)}><Icon size={18}/>{title}{id==='reviews'&&pending>0&&<b>{pending}</b>}</button>)}</nav>
    <div className="admin-workspace">
      <section className={`admin-map-area ${pickMode!=='select'?'is-picking':''}`} aria-label="Карта редактора">
        <div ref={mapNode} className="admin-map"/>
        <div className="admin-map-badge"><span className="live-dot"/>Шайдон<span>Редактор</span></div>
        <div className="admin-map-controls"><button aria-label="Приблизить" onClick={()=>atlas.current?.map.zoomIn()}><Plus/></button><button aria-label="Отдалить" onClick={()=>atlas.current?.map.zoomOut()}><Minus/></button><button aria-label="Показать Шайдон" onClick={()=>atlas.current?.map.easeTo({center:[70.3597,40.6602],zoom:16,bearing:0,pitch:0,duration:400})}><LocateFixed size={22}/></button></div>
        {!mapReady&&<div className="admin-map-loading">Открываем карту…</div>}
        {pickMode!=='select'?<div className="admin-map-hint"><MapPin size={18}/><span>{pickMode==='business'?'Нажмите на место организации':pickMode==='centre'?'Нажмите на центр фигуры':pickMode==='point'&&cityObject?cityKind(cityObject.kind).hint:pickMode==='city'&&cityObject?`${cityKind(cityObject.kind).hint} · точек: ${vertices.length}`:`Нажимайте на углы здания · точек: ${vertices.length}`}</span>{(pickMode==='building'||pickMode==='city')&&<><button title="Удалить последнюю точку" disabled={!vertices.length} onClick={()=>setVertices(previous=>previous.slice(0,-1))}><Undo2 size={18}/></button><button className="finish" disabled={vertices.length<(pickMode==='city'&&(cityObject?.kind==='path'||areaShape==='strip')?2:3)} onClick={pickMode==='city'?finishCityShape:finishOutline}>Готово</button></>}<button aria-label="Отменить выбор" onClick={()=>{setPickMode('select');setVertices([])}}><X size={18}/></button></div>:<div className="admin-map-hint quiet"><MousePointer2 size={17}/><span>{tab==='roads'?'Нажмите на улицу, чтобы изменить её':tab==='districts'?'Нажмите внутри микрорайона':tab==='businesses'?'Организации отмечены точками':tab==='buildings'?'Нажмите на здание: этажность и крыша':tab==='city'?'Дорожки, фонтаны, фонари, скамейки и деревья':'Отзывы публикуются после проверки'}</span></div>}
      </section>
      <aside className="admin-sidebar" aria-label="Панель редактирования">
        {(visibleError||notice)&&<div className={`admin-message ${visibleError?'is-error':''}`} role={visibleError?'alert':'status'}><span>{visibleError||notice}</span><button aria-label="Закрыть сообщение" onClick={()=>{setProblem('');setNotice('');setDismissedError(live.error)}}><X size={15}/></button></div>}
        {selection?<div className="admin-editor-heading"><button className="admin-back" onClick={resetEditor}><ChevronLeft size={18}/>К списку</button><span>{selection.kind==='road'?'Редактор улицы':selection.kind==='district'?'Редактор микрорайона':selection.kind==='business'?'Карточка организации':selection.kind==='footprint'?'Высота и крыша':selection.kind==='city'?'Благоустройство':'Редактор здания'}</span></div>:<div className="admin-section-heading"><div><span className="admin-eyebrow">КАРТА ATLAS</span><h1>{TABS.find(item=>item.id===tab)?.title}</h1></div>{tab==='businesses'&&<button className="admin-button primary icon" aria-label="Добавить организацию" onClick={()=>{const value=newBusiness();selectBusiness(value,false);setPickMode('business')}}><Plus size={20}/></button>}{tab==='buildings'&&<button className="admin-button primary icon" aria-label="Добавить здание" onClick={()=>{const value=newBuilding();selectBuilding(value,false);setPickMode('building')}}><Plus size={20}/></button>}</div>}

        {tab==='roads'&&selection?.kind==='road'&&selectedRoad?<form className="admin-form" onSubmit={saveStreet}>
          <div className="admin-object-caption"><MousePointer2 size={22}/><div><strong>{roadTitle(selectedRoad)}</strong><small>{selectedRoad.namingStatus==='proposed'?'Проектное название Atlas':'Название из исходных данных'}{selectedRoad.ref?` · ${selectedRoad.ref}`:''}</small></div></div>
          <label>Название улицы<input value={editName} onChange={event=>setEditName(event.target.value)} required maxLength={160}/></label>
          {(()=>{const oneway=isOneway(selectedRoad.tags),count=Number(asphalt),laned=asphalt!=='original'&&count>0;return <fieldset className="admin-asphalt"><legend>Покрытие и полосы</legend>
            {([['original','Исходный вид','Без дополнительного оформления'],['0','Общая полоса','1 полоса для обоих направлений']] as const).map(([value,title,subtitle])=><label className={asphalt===value?'chosen':''} key={value}><input type="radio" name="asphalt" value={value} checked={asphalt===value} onChange={()=>setAsphalt(value)}/><LanePreview lanes={value} oneway={oneway}/><span><strong>{title}</strong><small>{subtitle}</small></span>{asphalt===value&&<Check size={17}/>}</label>)}
            <div className={`admin-lane-count${laned?' chosen':''}`}>
              <LanePreview lanes={laned?asphalt:'1'} oneway={oneway}/>
              <span><strong>{oneway?'Полос в сторону движения':'Полос в каждую сторону'}</strong><small>{!laned?'Выберите число полос':oneway?`${count} ${laneWord(count)} в одну сторону`:`${count} туда + ${count} обратно`}</small></span>
              <div className="admin-lane-chips" role="radiogroup" aria-label="Число полос">{[1,2,3,4,5,6].map(value=><button type="button" role="radio" aria-checked={asphalt===String(value)} key={value} className={asphalt===String(value)?'chosen':''} onClick={()=>setAsphalt(String(value))}>{value}</button>)}</div>
            </div>
          </fieldset>})()}
          {groupRoads.length>1&&<label className="admin-check"><input type="checkbox" checked={wholeStreet} onChange={event=>setWholeStreet(event.target.checked)}/><span>Применить ко всей улице<small>{groupRoads.length} соединённых участков</small></span></label>}
          <p className="admin-help">Изменяется отображение карты. Количество полос не меняет разрешённые направления движения в маршрутах.</p>
          <button className="admin-button primary" disabled={busy||!editName.trim()}><Check size={18}/>{busy?'Сохранение…':'Сохранить улицу'}</button>
        </form>:tab==='districts'&&selection?.kind==='district'?<form className="admin-form" onSubmit={event=>{event.preventDefault();perform(()=>live.saveDistrict({districtId:selection.id,name:editName.trim()}),'Название микрорайона сохранено')}}><label>Название микрорайона<input value={editName} onChange={event=>setEditName(event.target.value)} required maxLength={160}/></label><p className="admin-help">Границы на карте приблизительные. Название относится к проекту Atlas.</p><button className="admin-button primary" disabled={busy||!editName.trim()}><Check size={18}/>{busy?'Сохранение…':'Сохранить название'}</button></form>:tab==='businesses'&&business?<form className="admin-form" onSubmit={event=>{event.preventDefault();perform(()=>live.saveBusiness({...business,name:business.name.trim()}),'Организация сохранена')}}>
          <label>Название организации<input value={business.name} onChange={event=>setBusiness({...business,name:event.target.value})} required maxLength={160}/></label>
          <label>Категория<select value={business.category} onChange={event=>setBusiness({...business,category:event.target.value})}>{categories.map(([value,title])=><option value={value} key={value}>{title}</option>)}</select></label>
          <div className="admin-position"><MapPin size={18}/><span>{business.lat.toFixed(6)}, {business.lon.toFixed(6)}</span><button type="button" onClick={()=>setPickMode('business')}>На карте</button></div>
          <div className="admin-two"><label>Широта<input type="number" step="any" min={35.8} max={41.9} required value={business.lat} onChange={event=>setBusiness({...business,lat:Number(event.target.value)})}/></label><label>Долгота<input type="number" step="any" min={66.3} max={76.1} required value={business.lon} onChange={event=>setBusiness({...business,lon:Number(event.target.value)})}/></label></div>
          <label>Адрес<input value={business.address} onChange={event=>setBusiness({...business,address:event.target.value})} maxLength={300}/></label>
          <label>Описание<textarea value={business.info} onChange={event=>setBusiness({...business,info:event.target.value})} rows={4} maxLength={5000} placeholder="Услуги, особенности, условия посещения"/></label>
          <details className="admin-form-section" open><summary>Контакты и часы работы</summary><label>Телефон<input type="tel" value={business.phone} onChange={event=>setBusiness({...business,phone:event.target.value})} maxLength={80} placeholder="+992 …"/></label><label>Электронная почта<input type="email" value={business.email} onChange={event=>setBusiness({...business,email:event.target.value})} maxLength={160}/></label><label>Сайт<input type="url" value={business.website} onChange={event=>setBusiness({...business,website:event.target.value})} maxLength={500} placeholder="https://…"/></label><label>Часы работы<input value={business.hours} onChange={event=>setBusiness({...business,hours:event.target.value})} maxLength={300} placeholder="Пн–Сб, 09:00–18:00"/></label></details>
          <details className="admin-form-section"><summary>Меню и услуги <span>{business.menu.length}</span></summary>{business.menu.map((item,index)=><div className="admin-menu-item" key={item.id}><div className="admin-row"><strong>Позиция {index+1}</strong><button className="admin-icon-button" type="button" aria-label={`Удалить позицию ${index+1}`} onClick={()=>setBusiness({...business,menu:business.menu.filter(value=>value.id!==item.id)})}><Trash2 size={16}/></button></div><label>Название<input value={item.name} required maxLength={160} onChange={event=>setBusiness({...business,menu:business.menu.map(value=>value.id===item.id?{...value,name:event.target.value}:value)})}/></label><label>Цена, сомони<input type="number" min="0" max="1000000" step="0.01" value={item.price} required onChange={event=>setBusiness({...business,menu:business.menu.map(value=>value.id===item.id?{...value,price:Number(event.target.value),currency:'TJS'}:value)})}/></label><label>Описание<input value={item.description} maxLength={1000} onChange={event=>setBusiness({...business,menu:business.menu.map(value=>value.id===item.id?{...value,description:event.target.value}:value)})}/></label></div>)}<button type="button" className="admin-button" onClick={()=>setBusiness({...business,menu:[...business.menu,{id:id(),name:'',price:0,currency:'TJS',description:''}]})}><Plus size={16}/>Добавить позицию</button></details>
          <label className="admin-check"><input type="checkbox" checked={business.reviewsEnabled} onChange={event=>setBusiness({...business,reviewsEnabled:event.target.checked})}/><span>Разрешить отзывы<small>Новые отзывы проходят проверку</small></span></label><label className="admin-check"><input type="checkbox" checked={business.published} onChange={event=>setBusiness({...business,published:event.target.checked})}/><span>Показывать на карте<small>Без отметки карточка остаётся черновиком</small></span></label>
          <button className="admin-button primary" disabled={busy||!business.name.trim()||pickMode==='business'}><Check size={18}/>{busy?'Сохранение…':'Сохранить организацию'}</button>
          {live.state.businesses.some(value=>value.id===business.id)&&deleteButtons(()=>live.deleteBusiness(business.id),'организацию')}
        </form>:tab==='city'&&cityObject?(()=>{
          const {title,icon:Icon,hint,fields}=cityKind(cityObject.kind),saved=live.state.cityObjects.some(value=>value.id===cityObject.id);
          const single=cityObject.geometry.type==='Point',placed=single?cityObject.geometry.coordinates.length===2:cityObject.geometry.coordinates.length>0;
          const generated=areaShape==='rectangle'||areaShape==='circle',narrow=cityObject.geometry.type==='Polygon'&&cityObject.geometry.coordinates.length>0&&isNarrowOutline(cityObject.geometry.coordinates[0]);
          return <form className="admin-form" onSubmit={event=>{event.preventDefault();perform(()=>live.saveCityObject(cityObject),'Объект сохранён. Карта пользователей обновляется автоматически.')}}>
          <div className="admin-object-caption"><Icon size={22}/><div><strong>{title}</strong><small>{saved?'На карте':'Новый объект'}</small></div></div>
          <label>Название · необязательно<input value={cityObject.name||''} onChange={event=>setCityObject({...cityObject,name:event.target.value})} maxLength={160}/></label>
          {(cityObject.kind==='square'||cityObject.kind==='lawn'||cityObject.kind==='fountain')&&<div className="admin-shape">
            <span>Форма</span>
            <div className="admin-row">{(cityObject.kind==='fountain'?FOUNTAIN_SHAPES:AREA_SHAPES).map(([value,label])=><button key={value} type="button" className={`admin-button${areaShape===value?' primary':''}`} onClick={()=>chooseAreaShape(value)}>{label}</button>)}</div>
            {areaShape==='strip'&&<label>Ширина полосы, м<input type="number" min={0.5} max={100} step={0.5} placeholder="3" value={cityObject.width??''} onChange={event=>{const width=Number(event.target.value);setCityObject({...cityObject,width:width>0?width:undefined})}}/></label>}
            {generated&&<>
              {areaShape==='rectangle'
                ?<div className="admin-two"><label>Ширина, м<input type="number" min={1} max={500} step={0.5} value={areaSize.width||''} onChange={event=>buildArea(areaCentre,areaShape,{...areaSize,width:Number(event.target.value)})}/></label><label>Длина, м<input type="number" min={1} max={500} step={0.5} value={areaSize.length||''} onChange={event=>buildArea(areaCentre,areaShape,{...areaSize,length:Number(event.target.value)})}/></label></div>
                :<label>{cityObject.kind==='fountain'?'Размер поперёк, м':'Диаметр, м'}<input type="number" min={1} max={500} step={0.5} value={areaSize.diameter||''} onChange={event=>buildArea(areaCentre,areaShape,{...areaSize,diameter:Number(event.target.value)})}/></label>}
              <label>Направление, °<input type="number" min={0} max={360} step={5} value={areaSize.rotation} onChange={event=>buildArea(areaCentre,areaShape,{...areaSize,rotation:Number(event.target.value)||0})}/></label>
              <div className="admin-position"><MapPin size={18}/><span>{areaCentre?`Центр: ${formatPoint(areaCentre)}`:'Центр ещё не выбран'}</span><button type="button" onClick={()=>setPickMode('centre')}>На карте</button></div>
              <CoordinateEntry action="Поставить центр" onError={setProblem} onPoint={point=>{buildArea(point,areaShape,areaSize);panTo(point[1],point[0],18);setProblem('');setNotice('Фигура построена. Проверьте размеры и сохраните.')}}/>
            </>}
          </div>}
          {(cityObject.kind==='path'||cityObject.kind==='square')&&<label>Покрытие<select value={cityObject.surface??'tiles'} onChange={event=>setCityObject({...cityObject,surface:event.target.value as 'plain'|'tiles'|'asphalt'})}>{SURFACE_OPTIONS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}
          {fields.map(({key,label,step})=>{const [min,max,fallback]=CITY_SIZES[cityObject.kind]?.[key]??[0,0];return <label key={key}>{label}<input type="number" min={min} max={max} step={step} placeholder={fallback===undefined?'авто':String(fallback)} value={cityObject[key]??''} onChange={event=>{const next={...cityObject};if(event.target.value==='')delete next[key];else next[key]=Number(event.target.value);setCityObject(next)}}/></label>})}
          {fields.some(field=>field.key==='rotation')&&<p className="admin-help">Направление: 0° — на север, 90° — на восток, 180° — на юг. У флага это сторона, куда развевается полотнище; у скамейки — куда смотрит сидящий. Пустое поле — размер по умолчанию.</p>}
          {!generated&&<div className="admin-drawing"><Icon size={28}/><strong>{pickMode!=='select'?(single?'Нажмите на карту':`Точек: ${vertices.length}`):placed?(single?'Место выбрано':'Контур нарисован'):'Ещё не отмечен'}</strong><p>{hint}{single?'.':', затем нажмите «Готово». Точки можно перетаскивать.'}</p>{cityObject.geometry.type==='Point'&&cityObject.geometry.coordinates.length===2&&<p>{formatPoint(cityObject.geometry.coordinates)}</p>}{cityObject.geometry.type==='LineString'&&cityObject.geometry.coordinates.length>1&&<p>Откуда: {formatPoint(cityObject.geometry.coordinates[0])}<br/>Куда: {formatPoint(cityObject.geometry.coordinates[cityObject.geometry.coordinates.length-1])}</p>}{pickMode==='select'&&<button className="admin-button" type="button" onClick={()=>drawCityObject(cityObject)}><Pencil size={16}/>{placed?'Изменить на карте':'Отметить на карте'}</button>}</div>}
          {(cityObject.kind==='path'||((cityObject.kind==='square'||cityObject.kind==='lawn')&&areaShape==='strip'))&&<RouteEntry onError={setProblem} onRoute={(start,end)=>{setCityObject({...cityObject,geometry:{type:'LineString',coordinates:[start,end]}});setVertices([]);setPickMode('select');atlas.current?.fit([start,end],{top:60,bottom:60,left:60,right:60},19);setProblem('');setNotice('Дорожка проведена. Выберите покрытие и сохраните; изгибы можно добавить кнопкой «Изменить на карте».')}}/>}
          {isPointObject(cityObject)
            ?<CoordinateEntry action="Поставить" onError={setProblem} onPoint={point=>{setCityObject({...cityObject,geometry:{type:'Point',coordinates:point}});setPickMode('select');panTo(point[1],point[0],18);setProblem('');setNotice('Объект поставлен по координатам. Проверьте размеры и сохраните.')}}/>
            :!generated&&<CoordinateEntry action="Добавить точку" onError={setProblem} onPoint={point=>{if(pickMode!=='city')drawCityObject(cityObject);setVertices(previous=>[...previous,point]);panTo(point[1],point[0],18);setProblem('');setNotice('Точка добавлена. Когда контур готов, нажмите «Готово».')}}/>}
          {narrow&&<p className="admin-message is-error">{NARROW}</p>}
          <p className="admin-help">Указывайте положение по собственным наблюдениям на месте.</p>
          <button className="admin-button primary" disabled={busy||pickMode!=='select'||!placed||narrow}><Check size={18}/>{busy?'Сохранение…':'Сохранить объект'}</button>
          {saved&&deleteButtons(()=>live.deleteCityObject(cityObject.id),'объект')}
        </form>})():tab==='buildings'&&footprint?(()=>{
          const {title,source}=footprintTitle(footprint.key),saved=live.state.buildingInfo[footprint.key];
          const levels=footprint.levels?Number(footprint.levels):undefined,height=footprint.height?Number(footprint.height):undefined,roof=footprint.roof;
          const ring=atlas.current?.houseRing(footprint.key);
          return <form className="admin-form" onSubmit={event=>{event.preventDefault();perform(()=>live.saveBuildingInfo({key:footprint.key,...(levels?{levels}:{}),...(height?{height}:{}),...(roof?{roof}:{})}),'Здание обновлено. Карта пользователей обновляется автоматически.')}}>
          <div className="admin-object-caption"><Building2 size={22}/><div><strong>{title}</strong><small>{source}</small></div></div>
          <div className="admin-two"><label>Этажей<input type="number" min="1" max="60" step="1" value={footprint.levels} onChange={event=>setFootprint({...footprint,levels:event.target.value})}/></label><label>Высота, м · если известна<input type="number" min="1" max="500" step="0.1" value={footprint.height} onChange={event=>setFootprint({...footprint,height:event.target.value})}/></label></div>
          <p className="admin-help">Стены на карте: {wallHeight({levels,height})} м. Этаж считается по 3 м плюс 1 м цоколя; точная высота важнее этажей. Без данных дом показан условными 4 м.</p>
          <label>Крыша<select value={roof} onChange={event=>setFootprint({...footprint,roof:event.target.value as RoofShape|''})}>{ROOFS.map(([value,title])=><option key={value} value={value}>{title}</option>)}</select></label>
          {roof&&ring&&!roofFits(ring)&&<p className="admin-help">Контур сложнее прямоугольника, поэтому крыша останется плоской. Основной объём можно нарисовать отдельным зданием кнопкой «+».</p>}
          <button className="admin-button primary" disabled={busy||(!levels&&!height&&!roof)}><Check size={18}/>{busy?'Сохранение…':'Сохранить здание'}</button>
          {saved&&<button type="button" className="admin-button" disabled={busy} onClick={()=>perform(async()=>{await live.deleteBuildingInfo(footprint.key);setFootprint({...footprint,levels:'',height:'',roof:''})},'Параметры сброшены: дом снова показан условной высотой с плоской крышей.')}><Undo2 size={16}/>Сбросить параметры</button>}
        </form>})():tab==='buildings'&&building?<form className="admin-form" onSubmit={event=>{event.preventDefault();perform(()=>live.saveBuilding(building),'Здание добавлено на карту')}}>
          <label>Название или номер<input value={building.name||''} onChange={event=>setBuilding({...building,name:event.target.value})} maxLength={160} placeholder="Например, дом 12"/></label><div className="admin-two"><label>Этажей · необязательно<input type="number" min="1" max="60" step="1" value={building.levels??''} onChange={event=>{const {levels,...rest}=building;setBuilding(event.target.value?{...rest,levels:Number(event.target.value)}:rest)}}/></label><label>Высота, м · необязательно<input type="number" min="1" max="500" step="0.1" value={building.height??''} onChange={event=>{const {height,...rest}=building;setBuilding(event.target.value?{...rest,height:Number(event.target.value)}:rest)}}/></label></div><label>Крыша<select value={building.roof??''} onChange={event=>{const {roof,...rest}=building;setBuilding(event.target.value?{...rest,roof:event.target.value as RoofShape}:rest)}}>{ROOFS.map(([value,title])=><option key={value} value={value}>{title}</option>)}</select></label>{building.roof&&building.geometry.coordinates.length>0&&!roofFits(building.geometry.coordinates[0])&&<p className="admin-help">Контур сложнее прямоугольника, поэтому крыша останется плоской.</p>}
          <div className="admin-drawing"><Building2 size={28}/><strong>{pickMode==='building'?`Точек в контуре: ${vertices.length}`:building.geometry.coordinates.length?`Контур: ${building.geometry.coordinates[0].length-1} углов`:'Контур ещё не нарисован'}</strong><p>Нажмите на углы здания по порядку. Точки можно перетаскивать. Затем нажмите «Готово».</p>{pickMode==='building'?<div className="admin-row"><button type="button" className="admin-button" disabled={!vertices.length} onClick={()=>setVertices(previous=>previous.slice(0,-1))}><Undo2 size={16}/>Отменить точку</button><button type="button" className="admin-button primary" disabled={vertices.length<3} onClick={finishOutline}>Готово</button></div>:<button className="admin-button" type="button" onClick={()=>{setVertices((building.geometry.coordinates[0]||[]).slice(0,-1).map(point=>[...point]));setPickMode('building')}}><Pencil size={16}/>{building.geometry.coordinates.length?'Изменить контур':'Нарисовать контур'}</button>}</div>
          <CoordinateEntry action="Добавить угол" onError={setProblem} onPoint={point=>{if(pickMode!=='building'){setVertices((building.geometry.coordinates[0]||[]).slice(0,-1).map(corner=>[...corner]));setPickMode('building')}setVertices(previous=>[...previous,point]);panTo(point[1],point[0],18);setProblem('');setNotice('Угол добавлен. Когда контур готов, нажмите «Готово».')}}/>
          <p className="admin-help">Ручной контур Atlas. Указывайте фактическое положение здания по собственным данным.</p><button className="admin-button primary" disabled={busy||pickMode==='building'||!building.geometry.coordinates.length}><Check size={18}/>{busy?'Сохранение…':'Сохранить здание'}</button>{live.state.buildings.some(value=>value.id===building.id)&&deleteButtons(()=>live.deleteBuilding(building.id),'здание')}
        </form>:<>
          {tab!=='reviews'&&<div className="admin-search"><Search size={18}/><input aria-label="Поиск объектов" placeholder={tab==='roads'?'Название улицы или номер дороги':'Найти по названию'} value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button aria-label="Очистить поиск" onClick={()=>setQuery('')}><X size={16}/></button>}</div>}
          {tab==='roads'&&<><label className="admin-scope"><input type="checkbox" checked={allCountry} onChange={event=>setAllCountry(event.target.checked)}/>Весь Таджикистан<span>{filteredRoads.length.toLocaleString('ru-RU')}</span></label><div className="admin-list">{filteredRoads.slice(0,150).map(road=><button key={road.id} className="admin-list-item" onClick={()=>selectRoad(road)}><MousePointer2 size={18}/><span><strong>{roadTitle(road)}</strong><small>{road.ref?`${road.ref} · `:''}{road.namingStatus==='proposed'?'Название Atlas':road.tags.highway==='service'?'Проезд':'Улица'}{live.state.roads[road.id]?' · изменено':''}</small></span><Pencil size={15}/></button>)}{filteredRoads.length>150&&<p className="admin-help">Первые 150 участков. Уточните название или выберите улицу на карте.</p>}{!filteredRoads.length&&<p className="admin-empty">{baseRoads.length?'Ничего не найдено':'Загружаем улицы…'}</p>}</div></>}
          {tab==='districts'&&<div className="admin-list">{districts.filter(area=>area.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).map(area=><button key={area.id} className="admin-list-item" onClick={()=>selectDistrict(area)}><Layers size={19}/><span><strong>{area.name}</strong><small>Шайдон · проектная зона</small></span><Pencil size={15}/></button>)}<p className="admin-help">Районы пронумерованы с севера на юг. Границы приблизительные.</p></div>}
          {tab==='businesses'&&<div className="admin-list">{live.state.businesses.filter(value=>`${value.name} ${value.address}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).map(value=><button key={value.id} className="admin-list-item" onClick={()=>selectBusiness(value)}><Store size={19}/><span><strong>{value.name}</strong><small>{value.published?'На карте':'Черновик'} · {categories.find(([key])=>key===value.category)?.[1]||value.category}</small></span><i className={`admin-status-dot ${value.published?'published':''}`}/></button>)}{!live.state.businesses.length&&<div className="admin-empty"><Store size={34}/><h2>Добавьте первую организацию</h2><p>Выберите место, заполните контакты, услуги и меню.</p><button className="admin-button primary" onClick={()=>{selectBusiness(newBusiness(),false);setPickMode('business')}}><Plus size={17}/>Добавить организацию</button></div>}</div>}
          {tab==='buildings'&&<div className="admin-list">{live.state.buildings.filter(value=>(value.name||'Здание').toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).map(value=><button key={value.id} className="admin-list-item" onClick={()=>selectBuilding(value)}><Building2 size={19}/><span><strong>{value.name||'Здание без названия'}</strong><small>Ручной контур Atlas</small></span><Pencil size={15}/></button>)}{!live.state.buildings.length&&<div className="admin-empty"><Building2 size={34}/><h2>Добавьте недостающее здание</h2><p>Нарисуйте его контур прямо на карте.</p><button className="admin-button primary" onClick={()=>{selectBuilding(newBuilding(),false);setPickMode('building')}}><Plus size={17}/>Нарисовать здание</button></div>}{Object.values(live.state.buildingInfo).filter(info=>footprintTitle(info.key).title.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).map(info=><button key={info.key} className="admin-list-item" onClick={()=>selectFootprint(info.key)}><Building2 size={19}/><span><strong>{footprintTitle(info.key).title}</strong><small>{info.height?`Высота ${info.height} м`:info.levels?`Этажей: ${info.levels}`:'Высота условная'} · крыша {roofTitle(info.roof).toLocaleLowerCase('ru')}</small></span><Pencil size={15}/></button>)}<p className="admin-help">Нажмите на любое здание на карте, чтобы указать этажность. Недостающее здание нарисуйте кнопкой «+».</p></div>}
          {tab==='city'&&<div className="admin-list">{CITY_GROUPS.map(group=><div key={group} className="admin-city-group"><small>{group}</small><div className="admin-row">{CITY_KINDS.filter(item=>item.group===group).map(({kind,title,icon:Icon})=><button key={kind} type="button" className="admin-button" onClick={()=>{const value=newCityObject(kind);selectCityObject(value,false);drawCityObject(value)}}><Icon size={16}/>{title}</button>)}</div></div>)}{live.state.cityObjects.filter(value=>`${value.name||''} ${cityKind(value.kind).title}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).map(value=>{const {title,icon:Icon}=cityKind(value.kind);return <button key={value.id} className="admin-list-item" onClick={()=>selectCityObject(value)}><Icon size={19}/><span><strong>{value.name||title}</strong><small>{[title,value.height&&`высота ${value.height} м`,value.width&&`ширина ${value.width} м`,value.length&&`длина ${value.length} м`].filter(Boolean).join(' · ')}</small></span><Pencil size={15}/></button>})}{!live.state.cityObjects.length&&<p className="admin-help">Добавьте дорожки, площадь, газоны, фонтан, флагшток, фонари, скамейки и деревья по наблюдениям на месте. На карте они появятся объёмом.</p>}</div>}
          {tab==='reviews'&&<><div className="admin-review-filters">{[['pending','Новые'],['approved','На карте'],['rejected','Отклонённые']].map(([key,title])=><button className={reviewFilter===key?'active':''} key={key} onClick={()=>setReviewFilter(key)}>{title}</button>)}</div><div className="admin-reviews">{live.state.reviews.filter(review=>review.status===reviewFilter).map(review=><article className="admin-review" key={review.id}><div className="admin-row"><strong>{review.name}</strong><span className="admin-stars">{'★'.repeat(review.rating)}{'☆'.repeat(5-review.rating)}</span></div><small>{live.state.businesses.find(value=>value.id===review.businessId)?.name||'Организация удалена'}</small><p>{review.text}</p><time>{new Date(review.createdAt).toLocaleString('ru-RU')}</time><div className="admin-row">{review.status!=='approved'&&<button className="admin-button primary" disabled={busy} onClick={()=>perform(()=>live.moderateReview(review.id,'approved'),'Отзыв опубликован')}><Check size={16}/>Опубликовать</button>}{review.status!=='rejected'&&<button className="admin-button" disabled={busy} onClick={()=>perform(()=>live.moderateReview(review.id,'rejected'),'Отзыв скрыт с карты')}><X size={16}/>{review.status==='approved'?'Скрыть':'Отклонить'}</button>}</div></article>)}{!live.state.reviews.some(review=>review.status===reviewFilter)&&<div className="admin-empty"><MessageSquare size={32}/><h2>Отзывов пока нет</h2><p>{reviewFilter==='pending'?'Новые отзывы пользователей появятся здесь для проверки.':'В этом разделе пока нет отзывов.'}</p></div>}</div></>}
        </>}
      </aside>
    </div>
  </main>;
}

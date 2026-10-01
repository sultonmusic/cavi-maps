import {readMapUrl, mapPath} from '../lib/map-url';
'use client';
import {siteUrl} from '@/lib/site-url';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Search,MapPin,Navigation,Coffee,Building2,ShoppingBag,HeartPulse,Landmark,Fuel,LocateFixed,Plus,Minus,ArrowUpRight,Mountain,Bookmark,X,Route,Compass,User} from 'lucide-react';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {createStreetIndex,type Road} from '@/lib/street-index';
import {roadPlace,districtPlace,districtAt,type District} from '@/lib/map-places';
import RoutePlanner from '@/components/route-planner';
import {useLiveMap} from '@/lib/live-store';
import {createAtlasGL, composeLabels, baseLabels, type AtlasGL, type AtlasLabel, type BuildingData, type SelectionGeometry} from '@/lib/atlas-gl';
import {isLanes,isOneway} from '@/lib/lanes.mjs';
import {landmarkPlace,landmarkPlaces} from '@/lib/landmarks.mjs';
import {poiNearby,poiStyle} from '@/lib/poi-icons.mjs';
import {poiPinSvg} from '@/lib/poi-draw';
import {floorsLabel,floorsOf} from '@/lib/building-ray.mjs';
import {isShaydonKey} from '@/lib/building-pick';
import {onProfileChange,readBuildingDetail} from '@/lib/profile-store';
import {cityAt} from '@/lib/cities.mjs';
import type {Marker} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import BusinessDetails,{businessPlace} from '@/components/business-details';
import {Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription} from '@/components/ui/sheet';
type Place={id:string;lat:number;lon:number;tags:Record<string,string>};
type LabelHit={name:string;kind:string;owner?:string;lat:number;lon:number};
type HouseHit={number:number;street:string;label:string;lat:number;lon:number;key?:string;levels?:number;height?:number;stated?:boolean};
/** "улица 87 дом 77", "ул 87, 77" and "87 77" all have to reach the same house. */
const NOISE=/^(дом|д|улица|ул|кӯча|куча|k|№|no)$/;
function terms(value:string){
 return value.toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[.,;:()"«»/\\-]+/g,' ')
  .split(/\s+/).filter(part=>part&&!NOISE.test(part));
}
function housePlace(hit:HouseHit):Place{
 const title=hit.label||(hit.number?(hit.street?`${hit.street}, дом ${hit.number}`:`Дом ${hit.number}`):'Здание');
 const city=!hit.key||isShaydonKey(hit.key)?'Шайдон':cityAt(hit.lat,hit.lon)?.name;
 const approx=!hit.levels&&hit.stated&&hit.height?floorsOf(hit.height):0;
 return {id:`house:${hit.lat.toFixed(6)},${hit.lon.toFixed(6)}`,lat:hit.lat,lon:hit.lon,
  tags:{name:title,'name:ru':title,'atlas:type':'house',...(city?{'addr:city':city}:{}),
   ...(hit.street?{'atlas:street':hit.street}:{}),...(hit.number?{'atlas:house':String(hit.number)}:{}),
   ...(hit.key?{'atlas:building':hit.key}:{}),...(hit.levels?{'building:levels':String(hit.levels)}:{}),
   ...(approx?{'atlas:levels-approx':String(approx)}:{}),...(hit.stated&&hit.height?{'atlas:height':String(Math.round(hit.height))}:{})}};
}
type Tab='search'|'route'|'nav'|'profile';
type Sheet='peek'|'half'|'full';
const SHEET_ORDER:Sheet[]=['peek','half','full'];
const placeKinds:Record<string,string>={village:'Село',hamlet:'Посёлок',town:'Город',city:'Город',neighbourhood:'Микрорайон',district:'Микрорайон',country:'Страна',road:'Улица'};
const cities:Record<string,number[]>={'Таджикистан':[38.9,71,7],'Шайдон':[40.6601966,70.3597068,16],Душанбе:[38.575,68.79,13],'Худжанд':[40.283,69.623,13],Бохтар:[37.837,68.78,13],'Куляб':[37.914,69.785,13],'Хорог':[37.49,71.55,13],Пенджикент:[39.495,67.61,13]};
const cats=[['all','Все',MapPin],['food','Еда',Coffee],['hotel','Отели',Building2],['shop','Магазины',ShoppingBag],['health','Здоровье',HeartPulse],['tourism','Достопримечательности',Landmark],['fuel','АЗС',Fuel]] as const;
function category(p:Place){let t=p.tags;if(t['atlas:category'])return cats.some(c=>c[0]===t['atlas:category'])?t['atlas:category']:'all';if(['restaurant','cafe','fast_food','bar','pub','food_court'].includes(t.amenity))return 'food';if(['hotel','guest_house','hostel','motel'].includes(t.tourism))return 'hotel';if(t.shop)return 'shop';if(['hospital','clinic','pharmacy','doctors','dentist'].includes(t.amenity))return 'health';if(t.amenity==='fuel')return 'fuel';if(t.tourism)return 'tourism';return 'all'}
const BUSINESS_KINDS:Record<string,string>={food:'Еда',shop:'Магазин',hotel:'Отель',health:'Здоровье',fuel:'АЗС',tourism:'Достопримечательность',service:'Услуги',other:'Организация'};
function placeKind(p:Place){
 const type=p.tags['atlas:type'];
 if(type==='house'){const kind=p.tags['atlas:house']?'Дом':'Здание',exact=Number(p.tags['building:levels'])||0,n=exact||Number(p.tags['atlas:levels-approx'])||0;return n?`${kind} · ${exact?'':'≈ '}${floorsLabel(n)}`:kind}
 if(type==='label')return placeKinds[p.tags['atlas:place']]||'Место';
 if(type==='street')return 'Улица';
 if(type==='district')return 'Микрорайон';
 if(type==='business')return BUSINESS_KINDS[p.tags['atlas:category']]||'Организация';
 if(p.id.startsWith('point:'))return 'Место на карте';
 const chip=cats.find(c=>c[0]===category(p));
 return chip&&chip[0]!=='all'?chip[1]:(types[p.tags.amenity]||'Место');
}
function name(p:Place){return p.tags['name:ru']||p.tags.name||p.tags['name:en']||'Без названия'}
function address(p:Place){return [p.tags['addr:city'],p.tags['atlas:street']||p.tags['addr:street'],p.tags['addr:housenumber']].filter(Boolean).join(', ')}
const types:Record<string,string>={bank:'Банк',atm:'Банкомат',school:'Школа',university:'Университет',college:'Колледж',kindergarten:'Детский сад',place_of_worship:'Религиозное сооружение',post_office:'Почта',police:'Полиция',parking:'Парковка',toilets:'Туалет',drinking_water:'Питьевая вода',bus_station:'Автостанция',marketplace:'Рынок',community_centre:'Общественный центр',townhall:'Администрация',library:'Библиотека',theatre:'Театр',cinema:'Кинотеатр',car_wash:'Автомойка',taxi:'Стоянка такси'};
export default function Home(){
const [places,setPlaces]=useState<Place[]>([]),[query,setQuery]=useState(''),[cat,setCat]=useState('all'),[selected,setSelected]=useState<Place|null>(null),[error,setError]=useState(''),[ready,setReady]=useState(false),[saved,setSaved]=useState<string[]>([]),[onlySaved,setOnlySaved]=useState(false),[limit,setLimit]=useState(60),[destination,setDestination]=useState<Place|null>(null),[plannerOpen,setPlannerOpen]=useState(false),[navigating,setNavigating]=useState(false);
const live=useLiveMap();
const [baseRoads,setRoads]=useState<Road[]>([]),[baseDistricts,setDistricts]=useState<District[]>([]),[buildingData,setBuildingData]=useState<BuildingData|null>(null),[shippedLabels,setShippedLabels]=useState<AtlasLabel[]>([]),[viewCity,setViewCity]=useState('Шайдон'),[centre,setCentre]=useState<[number,number]>([70.3597068,40.6601966]);
const roads=useMemo(()=>baseRoads.map(road=>{const edit=live.state.roads[road.id];return edit?.name?{...road,name:edit.name,tags:{...road.tags,'atlas:edited':'yes'}}:road}),[baseRoads,live.state.roads]);
const districts=useMemo(()=>baseDistricts.map(d=>live.state.districts[d.id]?.name?{...d,name:live.state.districts[d.id].name}:d),[baseDistricts,live.state.districts]);
const businessPlaces=useMemo<Place[]>(()=>live.state.businesses.filter(b=>b.published).map(businessPlace),[live.state.businesses]);
const visiblePlaces=useMemo<Place[]>(()=>[...places,...businessPlaces],[places,businessPlaces]);
const selectedBusiness=selected?.tags['atlas:business-id']?live.state.businesses.find(b=>b.id===selected.tags['atlas:business-id']&&b.published):undefined;

const streetIndex=useMemo(()=>createStreetIndex(roads),[roads]);
const streetPlaces=useMemo(()=>roads.map(r=>roadPlace(r)).filter((p):p is Place=>!!p),[roads]);
const areaPlaces=useMemo(()=>districts.map(d=>districtPlace(d)),[districts]);
const allPlaces=useMemo(()=>[...visiblePlaces,...streetPlaces,...areaPlaces],[visiblePlaces,streetPlaces,areaPlaces]);
const [aboutOpen,setAboutOpen]=useState(false),[sheet,setSheet]=useState<Sheet>('half'),[tab,setTab]=useState<Tab>('search'),[tilted,setTilted]=useState(false);
const atlas=useRef<AtlasGL|null>(null),node=useRef<HTMLDivElement>(null),sheetNode=useRef<HTMLElement>(null),drag=useRef<{y:number;height:number;from:number}|null>(null),destinationMarker=useRef<Marker|null>(null),locationMarker=useRef<Marker|null>(null),pointIndex=useRef(new Map<string,Place>()),houseShape=useRef<SelectionGeometry|null>(null),routePick=useRef<((p:Place)=>boolean)|null>(null),pointHandler=useRef<(p:Place,label?:LabelHit)=>void>(()=>{});
useEffect(()=>{let cancelled=false;try{setSaved(JSON.parse(localStorage.getItem('atlas-saved')||'[]'))}catch{}fetch(siteUrl('/places.json')).then(r=>{if(!r.ok)throw Error();return r.json()}).then(data=>{if(!cancelled){let custom:Place[]=[];try{const value=JSON.parse(localStorage.getItem('atlas-custom-points')||'[]');if(Array.isArray(value))custom=value.filter(p=>(p?.id?.startsWith('point:')||p?.id?.startsWith('house:'))&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.tags)}catch{}{const known=new Set((data as Place[]).map(p=>p.id));setPlaces([...(data as Place[]),...landmarkPlaces().filter(p=>!known.has(p.id)),...custom])}}}).catch(()=>setError('Не удалось загрузить места. Обновите страницу.'));
fetch(siteUrl('/streets.json')).then(r=>{if(!r.ok)throw Error();return r.json()}).then(d=>{if(!cancelled)setRoads(d.roads)}).catch(()=>{if(!cancelled)setError('Названия улиц не загрузились. Обновите страницу.')});
fetch(siteUrl('/districts.json')).then(r=>r.ok?r.json():null).then(d=>{if(!cancelled&&d)setDistricts(d.districts)}).catch(()=>{});
fetch(siteUrl('/shaydon-buildings.json')).then(r=>r.ok?r.json():null).then(d=>{if(!cancelled&&d)setBuildingData(d)}).catch(()=>{});
fetch(siteUrl('/shaydon-osm-buildings.json')).then(r=>r.ok?r.json():null).then(d=>{if(!cancelled&&d)atlas.current?.setOsmBuildings(d.buildings)}).catch(()=>{});
baseLabels().then(list=>{if(!cancelled)setShippedLabels(list)}).catch(()=>{if(!cancelled)setError('Названия не загрузились. Обновите страницу.')});
if(node.current){atlas.current=createAtlasGL(node.current,setError);atlas.current.setBuildingDetail(readBuildingDetail());
 try{const last=JSON.parse(localStorage.getItem('atlas-view')||'null');
  if(last&&Number.isFinite(last.center?.[0])&&Number.isFinite(last.center?.[1]))
   atlas.current.map.jumpTo({center:last.center,zoom:last.zoom??15,bearing:last.bearing??0,pitch:last.pitch??0})}catch{}
 const shared=readMapUrl();if(shared)atlas.current.map.jumpTo(shared);
 setReady(true);atlas.current.ready.catch(()=>{if(!cancelled)setError('Не удалось загрузить карту. Обновите страницу.')})}
return()=>{cancelled=true;destinationMarker.current?.remove();locationMarker.current?.remove();atlas.current?.destroy();atlas.current=null}},[]);
useEffect(()=>{const restore=()=>{const shared=readMapUrl();if(shared)atlas.current?.map.jumpTo(shared)};window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore)},[]);
useEffect(()=>{const parentOrigin=new URLSearchParams(location.search).get('parentOrigin');if(!parentOrigin||window.parent===window)return;
 const receive=(event:MessageEvent)=>{if(event.source!==window.parent||event.origin!==parentOrigin||event.data?.type!=='cavi:route')return;
 const coordinates=event.data.coordinates;if(!Array.isArray(coordinates)||coordinates.length<2||coordinates.length>50000||coordinates.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<66||p[0]>76.5||p[1]<35.5||p[1]>42))return;
 const instance=atlas.current;if(!instance)return;instance.ready.then(()=>{if(atlas.current!==instance)return;const map=instance.map,data={type:'Feature' as const,properties:{},geometry:{type:'LineString' as const,coordinates}};
 const source=map.getSource('partner-route') as import('maplibre-gl').GeoJSONSource|undefined;if(source)source.setData(data);else{map.addSource('partner-route',{type:'geojson',data});map.addLayer({id:'partner-route',type:'line',source:'partner-route',paint:{'line-color':'#2563eb','line-width':6}})}
 const bounds=coordinates.reduce((b,p)=>[Math.min(b[0],p[0]),Math.min(b[1],p[1]),Math.max(b[2],p[0]),Math.max(b[3],p[1])],[Infinity,Infinity,-Infinity,-Infinity]);map.fitBounds([[bounds[0],bounds[1]],[bounds[2],bounds[3]]],{padding:50});}).catch(()=>{});
 };window.addEventListener('message',receive);window.parent.postMessage({type:'cavi:ready'},parentOrigin);return()=>window.removeEventListener('message',receive)},[ready]);
useEffect(()=>{if(buildingData)atlas.current?.setBuildings(buildingData)},[buildingData]);
// Profile switch «Подробные здания»: windows, roofs and street trees close in.
useEffect(()=>onProfileChange(()=>atlas.current?.setBuildingDetail(readBuildingDetail())),[]);
const roadNames=useMemo(()=>Object.fromEntries(Object.values(live.state.roads).filter(edit=>edit.name?.trim()).map(edit=>[edit.roadId,edit.name!.trim()])),[live.state.roads]);
const districtNames=useMemo(()=>Object.fromEntries(Object.values(live.state.districts).filter(edit=>edit.name?.trim()).map(edit=>[edit.districtId,edit.name.trim()])),[live.state.districts]);
const pavedRoads=useMemo(()=>Object.values(live.state.roads).filter(edit=>isLanes(edit.asphalt)).map(edit=>{const road=baseRoads.find(item=>item.id===edit.roadId);return {id:edit.roadId,asphalt:edit.asphalt as number,oneway:isOneway(road?.tags),coordinates:road?.coordinates??[]}}).filter(road=>road.coordinates.length>1),[live.state.roads,baseRoads]);
useEffect(()=>{atlas.current?.setLabels(composeLabels(shippedLabels,{roads:baseRoads,districts:baseDistricts,roadNames,districtNames,buildings:live.state.buildings}))},[shippedLabels,baseRoads,baseDistricts,roadNames,districtNames,live.state.buildings]);
useEffect(()=>{atlas.current?.setLiveRoads(pavedRoads)},[pavedRoads]);
useEffect(()=>{atlas.current?.setAdminBuildings(live.state.buildings)},[live.state.buildings]);
useEffect(()=>{atlas.current?.setBuildingInfo(live.state.buildingInfo)},[live.state.buildingInfo]);
useEffect(()=>{atlas.current?.setCityObjects(live.state.cityObjects)},[live.state.cityObjects]);
useEffect(()=>{
 const refresh=(p:Place|null)=>{if(!p)return p;const business=p.id.startsWith('business:');if(business&&(!live.ready||!live.connected))return p;const fresh=allPlaces.find(item=>item.id===p.id);if(fresh){const unchanged=JSON.stringify(fresh.tags)===JSON.stringify(p.tags)&&(!business||fresh.lat===p.lat&&fresh.lon===p.lon);return unchanged?p:business?fresh:{...p,tags:fresh.tags}}return business?null:p};
 setSelected(refresh);const next=refresh(destination);if(next!==destination){setDestination(next);if(!next){setPlannerOpen(false);setNavigating(false)}}
},[allPlaces,live.ready,live.connected]);
function choosePoint(p:Place,label?:LabelHit){
 if(label&&p.id.startsWith('point:')){
  const road=label.owner?streetIndex.byId.get(label.owner):undefined,area=label.owner?districts.find(d=>d.id===label.owner):undefined,tapped={lat:p.lat,lon:p.lon},named=road?roadPlace(road,tapped):null;
  p=named||(area?districtPlace(area,tapped):{id:`label:${label.kind}:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`,lat:p.lat,lon:p.lon,tags:{name:label.name,'name:ru':label.name,'atlas:type':'label','atlas:place':label.kind}});
 }
 else if(p.id.startsWith('point:')&&(atlas.current?.map.getZoom()||16)>=15){const metersPerPixel=156543*Math.cos(p.lat*Math.PI/180)/2**(atlas.current?.map.getZoom()||16);const hit=streetIndex.nearest(p.lat,p.lon,Math.max(8,Math.min(45,metersPerPixel*18)));if(hit){p=roadPlace(hit.road,{lat:p.lat,lon:p.lon})!}else{const district=districtAt(districts,p.lat,p.lon);if(district)p=districtPlace(district,{lat:p.lat,lon:p.lon})}}if(routePick.current?.(p))return;setSheet('peek');setDestination(p);
 // On the route tab, or while a route is being planned, a tap names point B and planning carries on.
 if(tab==='route'||plannerOpen){setSelected(null);setPlannerOpen(true)}else{setPlannerOpen(false);setSelected(p)}
 atlas.current?.reveal(p.lat,p.lon,{top:70,bottom:Math.min(260,(atlas.current.map.getCanvas().clientHeight||500)*.45)})}
pointHandler.current=choosePoint;
useEffect(()=>{if(roads.length&&selected?.id.startsWith('point:')&&!plannerOpen)choosePoint(selected)},[streetIndex]);
function beginRoute(p:Place){setSheet('peek');setDestination(p);setSelected(null);setPlannerOpen(true)}
useEffect(()=>{const instance=atlas.current;if(!ready||!instance)return;
 // Any touch on the map itself means the reader wants to see the map.
 const collapse=()=>setSheet('peek');
 const surface=instance.map.getCanvasContainer();
 surface.addEventListener('pointerdown',collapse);
 const handler=(event:any)=>{const hit=instance.pick(event);
  if(hit.kind==='point'){const known=pointIndex.current.get(hit.id)??landmarkPlace(hit.id);if(known){pointHandler.current(known);return}}
  if(hit.kind==='house'){houseShape.current=hit.shape;pointHandler.current(housePlace(hit));return}
  const p:Place={id:`point:${event.lngLat.lat.toFixed(7)},${event.lngLat.lng.toFixed(7)}`,lat:event.lngLat.lat,lon:event.lngLat.lng,tags:{name:'Точка на карте'}};
  pointHandler.current(p,hit.kind==='label'?hit.label:undefined)};
 instance.map.on('click',handler);
 return()=>{instance.map.off('click',handler);surface.removeEventListener('pointerdown',collapse)}},[ready]);
useEffect(()=>{destinationMarker.current?.remove();destinationMarker.current=null;
 // The place's own disc steps aside under the pin, and the pin carries its pictogram instead.
 atlas.current?.setPointFocus(destination?.id??null);
 const instance=atlas.current;if(!ready||!instance||!destination)return;
 const pin=instance.marker(poiPinSvg(poiStyle(destination.id,destination.tags).icon),'route-pin-wrap');
 pin.setLngLat([destination.lon,destination.lat]).addTo(instance.map);
 // A building's pin stands on its roof, not on the ground inside it.
 const lift=destination.tags['atlas:type']==='house'?Number(destination.tags['atlas:height'])||0:0;
 const follow=lift>4?()=>pin.setOffset(instance.liftOffset(destination.lon,destination.lat,lift)):null;
 if(follow){follow();instance.map.on('move',follow)}
 pin.getElement().addEventListener('click',()=>pointHandler.current(destination));
 destinationMarker.current=pin;return()=>{if(follow)instance.map.off('move',follow)}},[destination,ready]);
useEffect(()=>{const instance=atlas.current;if(!instance)return;
 let shape:SelectionGeometry|null=null;
 if(selected?.tags['atlas:type']==='street'){const road=streetIndex.byId.get(selected.tags['atlas:road-id']);if(road)shape={type:'LineString',coordinates:road.coordinates}}
 else if(selected?.tags['atlas:type']==='district'){const area=districts.find(item=>item.id===selected.tags['atlas:district-id']);if(area)shape=area.geometry as SelectionGeometry}
 else if(selected?.tags['atlas:type']==='house'){shape=houseShape.current}
 instance.setSelection(shape)},[selected,ready,streetIndex,districts]);
useEffect(()=>{if(window.isSecureContext&&'serviceWorker' in navigator)navigator.serviceWorker.register(siteUrl('/sw.js')).catch(()=>{})},[]);
// Every numbered footprint, searchable by street and number.
const houseIndex=useMemo(()=>{
 const data=buildingData;
 if(!data?.number?.length)return [] as {words:string[];place:Place}[];
 const [originLon,originLat]=data.origin,scale=data.scale,out:{words:string[];place:Place}[]=[];
 for(let i=0;i<data.buildings.length;i++){
  const house=data.number[i];if(!house)continue;
  const flat=data.buildings[i];let x=0,y=0,sumLon=0,sumLat=0,count=0;
  for(let j=0;j<flat.length;j+=2){x+=flat[j];y+=flat[j+1];sumLon+=originLon+x/scale;sumLat+=originLat+y/scale;count++}
  const lon=sumLon/count,lat=sumLat/count,slot=data.street?.[i]??-1;
  const street=slot>=0?data.streets?.[slot]:undefined;
  out.push({words:terms(`${street||''} ${house}`),place:housePlace({number:house,street:street||'',label:'',lat,lon})});
 }
 return out;
},[buildingData]);
// Houses by street and number, for the search list and for point A of a route.
const findHouses=useCallback((text:string,limit:number)=>{
 const wanted=terms(text);
 if(!wanted.length||!houseIndex.length)return [] as Place[];
 return houseIndex.filter(entry=>wanted.every(part=>entry.words.some(word=>word.startsWith(part))))
  .slice(0,limit).map(entry=>entry.place);
},[houseIndex]);
const houseMatches=useMemo(()=>findHouses(query,40),[query,findHouses]);
const filtered=useMemo(()=>{const c=cities[viewCity];let q=query.toLocaleLowerCase();return (query||onlySaved?allPlaces:visiblePlaces).filter(p=>(!onlySaved||saved.includes(p.id))&&(cat==='all'||category(p)===cat)&&(viewCity==='Таджикистан'||Math.abs(p.lat-c[0])<.17&&Math.abs(p.lon-c[1])<.2)&&(!q||Object.values(p.tags).join(' ').toLocaleLowerCase().includes(q)))},[visiblePlaces,allPlaces,query,cat,viewCity,onlySaved,saved]);
// Streets and places first, then the houses that match the same words.
const results=useMemo(()=>houseMatches.length?[...filtered,...houseMatches]:filtered,[houseMatches,filtered]);
useEffect(()=>{const instance=atlas.current;if(!ready||!instance)return;
 const settle=()=>{const centre=instance.map.getCenter();
  let closest='Таджикистан',shortest=Infinity;
  for(const [name,value] of Object.entries(cities)){if(name==='Таджикистан')continue;
   const gap=Math.hypot(centre.lat-value[0],(centre.lng-value[1])*Math.cos(centre.lat*Math.PI/180));
   if(gap<shortest){shortest=gap;closest=name}}
  setCentre(current=>current[0]===centre.lng&&current[1]===centre.lat?current:[centre.lng,centre.lat]);
  const next=shortest<0.22?closest:'Таджикистан';
  setViewCity(current=>current===next?current:next);
  const sharedUrl=new URL(location.href);sharedUrl.pathname=mapPath(centre.lat,centre.lng,next);sharedUrl.searchParams.set('z',instance.map.getZoom().toFixed(2));history.replaceState(null,'',sharedUrl);
  setTilted(instance.map.getPitch()>10);
  try{localStorage.setItem('atlas-view',JSON.stringify({center:[centre.lng,centre.lat],zoom:instance.map.getZoom(),bearing:instance.map.getBearing(),pitch:instance.map.getPitch()}))}catch{}};
 instance.map.on('moveend',settle);settle();
 return()=>{instance.map.off('moveend',settle)}},[ready]);
/** Tilt into the 3D view and back. Houses only stand up from zoom 15, so 3D also brings the map close enough to see them. */
function toggle3d(){const map=atlas.current?.map;if(!map)return;const flat=map.getPitch()<=10;
 map.easeTo({pitch:flat?60:0,zoom:flat?Math.max(map.getZoom(),17):map.getZoom(),duration:600})}
function chooseCity(name:string){const value=cities[name];if(!value)return;setViewCity(name);
 atlas.current?.map.jumpTo({center:[value[1],value[0]],zoom:value[2],bearing:0,pitch:0})}
// Only the places around what is on screen get a disc and a name: the 300 nearest, and the nearest
// hundred important ones beyond them, so a zoomed-out view is not empty past the nearest cluster.
const nearbyPoints=useMemo(()=>poiNearby(results,centre[0],centre[1]),[results,centre]);
useEffect(()=>{setLimit(60);pointIndex.current=new Map(results.map(p=>[p.id,p]));
 // Browsing, far-out zooms keep to the important places; a search, a chip or the saved list shows every match.
 const searching=!!query.trim()||cat!=='all'||onlySaved;
 atlas.current?.setPoints(nearbyPoints.map(p=>{const style=poiStyle(p.id,p.tags);return {id:p.id,lat:p.lat,lon:p.lon,name:name(p),category:category(p),icon:style.icon,rank:searching?0:style.rank}}))},[results,nearbyPoints,ready,query,cat,onlySaved]);
function sheetOffset(state:Sheet,height:number){return state==='full'?0:state==='half'?height*0.46:Math.max(0,height-128)}
function gripDown(event:React.PointerEvent<HTMLButtonElement>){
 const element=sheetNode.current;if(!element)return;
 const height=element.getBoundingClientRect().height;
 drag.current={y:event.clientY,height,from:sheetOffset(sheet,height)};
 element.style.transition='none';event.currentTarget.setPointerCapture(event.pointerId);
}
function gripMove(event:PointerEvent){
 const state=drag.current,element=sheetNode.current;if(!state||!element)return;
 const offset=Math.max(0,Math.min(state.height-90,state.from+event.clientY-state.y));
 element.style.transform=`translateY(${offset}px)`;
}
function gripUp(){
 const state=drag.current,element=sheetNode.current;if(!state||!element)return;
 drag.current=null;element.style.transition='';
 const current=new DOMMatrixReadOnly(getComputedStyle(element).transform).m42;
 const nearest=SHEET_ORDER.reduce((best,option)=>
  Math.abs(sheetOffset(option,state.height)-current)<Math.abs(sheetOffset(best,state.height)-current)?option:best,SHEET_ORDER[0]);
 element.style.transform='';setSheet(nearest);
}
useEffect(()=>{window.addEventListener('pointermove',gripMove);window.addEventListener('pointerup',gripUp);
 return()=>{window.removeEventListener('pointermove',gripMove);window.removeEventListener('pointerup',gripUp)}});
// A place with no address tags still stands on a street.
function placeAddress(p:Place){
 const known=address(p);
 // A building off Shaydon's numbered streets still stands on a street: its town and the nearest one.
 if(known&&(p.tags['atlas:type']!=='house'||p.tags['atlas:street']))return known;
 const hit=streetIndex.nearest(p.lat,p.lon,90);
 const street=hit?.road.name||hit?.road.ref;
 return street?[p.tags['addr:city'],street].filter(Boolean).join(', '):known||`${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
}
function open(p:Place){choosePoint(p);atlas.current?.map.easeTo({center:[p.lon,p.lat],zoom:Math.max(17,atlas.current.map.getZoom()),duration:400})}
function save(p:Place){const own=(id:string)=>id.startsWith('point:')||id.startsWith('house:');
 if(own(p.id)&&!places.some(item=>item.id===p.id)){const custom=[...places.filter(item=>own(item.id)),p];setPlaces(prev=>[...prev,p]);localStorage.setItem('atlas-custom-points',JSON.stringify(custom))}let next=saved.includes(p.id)?saved.filter(id=>id!==p.id):[...saved,p.id];setSaved(next);localStorage.setItem('atlas-saved',JSON.stringify(next))}
function locate(){const instance=atlas.current;if(!instance)return;
 if(!navigator.geolocation){setError('Геолокация недоступна в этом браузере. Выберите точку на карте.');return}
 navigator.geolocation.getCurrentPosition(position=>{const here:[number,number]=[position.coords.longitude,position.coords.latitude];
  instance.map.easeTo({center:here,zoom:Math.max(15,instance.map.getZoom()),duration:400});
  locationMarker.current?.remove();
  locationMarker.current=instance.marker('<span class="here-dot"></span>','here-marker','center').setLngLat(here).addTo(instance.map)},
  ()=>setError('Не удалось определить местоположение. Проверьте разрешение браузера. Можно выбрать точку на карте.'))}
useEffect(()=>{if(!ready||!node.current)return;const observer=new ResizeObserver(()=>atlas.current?.map.resize());observer.observe(node.current);return()=>observer.disconnect()},[ready]);
return <main className={"atlas tab-"+tab+" sheet-"+sheet+(plannerOpen?" route-planning":"")+(navigating?" is-navigating":"")}><section className="workspace"><aside className="explorer" id="explorer" ref={sheetNode}><button className="sheet-grip" aria-label="Развернуть или свернуть список" onPointerDown={gripDown} onClick={()=>setSheet(sheet==='full'?'peek':sheet==='half'?'full':'half')}><i/></button><div className="search-area"><div className="eyebrow">ГОРОДА И МЕСТА РЯДОМ</div><div className="city-row"><h1>{viewCity}</h1><Select value={viewCity} onValueChange={v=>v&&chooseCity(v)}><SelectTrigger aria-label="Выбрать город"><SelectValue/></SelectTrigger><SelectContent>{Object.keys(cities).map(c=><SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></div><label className="search"><Search size={21}/><input placeholder="Место, адрес или организация" value={query} onFocus={()=>setSheet(sheet==='peek'?'half':sheet)} onChange={e=>{setQuery(e.target.value);if(sheet==='peek')setSheet('half')}}/>{query&&<button aria-label="Очистить поиск" onClick={()=>setQuery('')}><X size={16}/></button>}</label><div className="categories">{cats.map(([id,label,Icon])=><button key={id} className={cat===id?'chosen':''} onClick={()=>setCat(id)}><Icon size={17}/>{label}</button>)}</div></div><div className="results-title"><strong>{onlySaved?'Избранные места':'Места рядом'}</strong><span>{results.length.toLocaleString('ru-RU')} мест</span></div><div className="results">{!places.length&&!error?<p className="empty">Загружаем места…</p>:results.length===0?<div className="empty"><Search size={28}/><h2>Ничего не найдено</h2><p>Попробуйте другой запрос или поиск по всей стране.</p><button onClick={()=>{chooseCity('Таджикистан');setQuery('');setCat('all');setOnlySaved(false)}}>Показать все места</button></div>:results.slice(0,limit).map(p=>{let c=cats.find(c=>c[0]===category(p))!;const Icon=c[2];return <button className="place" key={p.id} onClick={()=>open(p)}><span className={'place-icon '+category(p)}><Icon size={22}/></span><span className="place-text"><strong>{name(p)}</strong><span>{placeKind(p)}</span><small>{placeAddress(p)}</small></span><ArrowUpRight size={17}/></button>})}{results.length>limit&&<button className="more" onClick={()=>setLimit(limit+60)}>Показать ещё</button>}</div><footer><span title={live.error||'Изменения администратора появляются автоматически'}>{live.connected?'● Изменения онлайн':live.ready?'○ Нет связи с обновлениями':'Подключение…'}</span><button onClick={()=>setAboutOpen(true)}>О карте</button></footer></aside>
<section className="map-wrap" aria-label="Интерактивная карта"><div ref={node} className="map"/><div className="map-label"><span className="live-dot"/>{viewCity}<span>Карта Atlas</span></div><div className="map-controls"><button aria-label="Приблизить" onClick={()=>atlas.current?.map.zoomIn()}><Plus/></button><button aria-label="Отдалить" onClick={()=>atlas.current?.map.zoomOut()}><Minus/></button><button className="view-mode" aria-label={tilted?'Плоский вид':'Объёмный вид'} onClick={toggle3d}>{tilted?'2D':'3D'}</button><button aria-label="На север, без наклона" onClick={()=>atlas.current?.map.easeTo({bearing:0,pitch:0,duration:350})}><svg className="north-needle" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 2.5 16.2 12H7.8Z" fill="#e0453a"/><path d="M12 21.5 7.8 12h8.4Z" fill="#a4b0aa"/><circle cx="12" cy="12" r="1.6" fill="#fff"/></svg></button><button aria-label="Моё местоположение" onClick={locate}><LocateFixed/></button></div>{error&&<div role="alert" className="error">{error}<button onClick={()=>setError('')} aria-label="Закрыть сообщение"><X size={16}/></button></div>}<RoutePlanner atlasRef={atlas} ready={ready} places={allPlaces} saved={saved} destination={destination} open={plannerOpen} onClose={()=>setPlannerOpen(false)} onDestinationChange={setDestination} onNavigationChange={setNavigating} pickRef={routePick} findHouses={findHouses}/></section></section>
{tab==='route'&&!plannerOpen&&<section className="tab-panel"><Route size={26}/><h2>Проезд</h2><p>Выберите точку Б: нажмите место на карте или найдите его в поиске.</p><button onClick={()=>{setTab('search');setSheet('half')}}><Search size={18}/>Найти место</button></section>}
{tab==='nav'&&!navigating&&<section className="tab-panel"><Compass size={26}/><h2>Навигатор</h2><p>{destination?'Постройте маршрут в разделе «Проезд», затем нажмите «В путь».':'Сначала выберите точку Б на карте, затем постройте маршрут.'}</p><button onClick={locate}><LocateFixed size={18}/>Моё местоположение</button></section>}
<nav className="bottom-nav" aria-label="Разделы карты">
<button className={tab==='search'?'active':''} aria-current={tab==='search'?'page':undefined} onClick={()=>{setTab('search');setSheet('half');setPlannerOpen(false)}}><Search size={21}/>Поиск</button>
<button className={tab==='route'?'active':''} aria-current={tab==='route'?'page':undefined} onClick={()=>{setTab('route');setSheet('peek');if(destination)setPlannerOpen(true)}}><Route size={21}/>Проезд</button>
<button className={tab==='nav'?'active':''} aria-current={tab==='nav'?'page':undefined} onClick={()=>{setTab('nav');setSheet('peek')}}><Compass size={21}/>Навигатор</button>
<button className={tab==='profile'?'active':''} aria-current={tab==='profile'?'page':undefined} onClick={()=>{setTab('profile');setSheet('peek')}}><User size={21}/>Профиль</button>
</nav>
<Sheet open={tab==='profile'} onOpenChange={o=>{if(!o)setTab('search')}}><SheetContent className="detail"><SheetHeader><SheetTitle className="detail-title">Профиль</SheetTitle><SheetDescription>Atlas · Таджикистан</SheetDescription></SheetHeader><div className="detail-body profile-body">
<button className="profile-row" onClick={()=>{setOnlySaved(true);setTab('search');setSheet('half')}}><Bookmark size={19}/><span>Избранное<small>{saved.length} мест</small></span><ArrowUpRight size={17}/></button>
<button className="profile-row" onClick={()=>{chooseCity('Таджикистан');setOnlySaved(false);setTab('search');setSheet('peek')}}><Mountain size={19}/><span>Весь Таджикистан<small>Показать всю страну</small></span><ArrowUpRight size={17}/></button>
<button className="profile-row" onClick={()=>{setTab('search');setAboutOpen(true)}}><MapPin size={19}/><span>О карте<small>Источники и лицензии</small></span><ArrowUpRight size={17}/></button>
<a className="profile-row" href={siteUrl('/admin')}><Building2 size={19}/><span>Панель администратора<small>Управление картой</small></span><ArrowUpRight size={17}/></a>
<p className="profile-live">{live.connected?'● Изменения онлайн':live.ready?'○ Нет связи с обновлениями':'Подключение…'}</p>
</div></SheetContent></Sheet>
<Sheet modal={false} open={!!selected} onOpenChange={o=>!o&&setSelected(null)}><SheetContent side="bottom" showOverlay={false} className="detail place-detail">{selected&&<><SheetHeader><SheetTitle className="detail-title">{name(selected)}</SheetTitle><SheetDescription>{placeKind(selected)}</SheetDescription></SheetHeader><div className="detail-body compact-place-body"><p className="place-address">{placeAddress(selected)}</p>{selected.tags['atlas:naming']==='proposed'&&<span className="proposal-label">Название Atlas · проектное</span>}<div className="place-actions"><button className="route" onClick={()=>beginRoute(selected)}><Navigation size={18}/>Маршрут</button><button className="bookmark" onClick={()=>save(selected)}><Bookmark size={18}/>{saved.includes(selected.id)?'Сохранено':'В избранное'}</button></div><details className="place-more"><summary>{selectedBusiness?'Информация, меню и отзывы':'Подробнее'}</summary>{selectedBusiness&&<BusinessDetails key={selectedBusiness.id} business={selectedBusiness} reviews={live.state.reviews} submitReview={live.submitReview}/>}<p className="coords">{selected.lat.toFixed(6)}, {selected.lon.toFixed(6)}</p>{selected.tags['atlas:naming']==='proposed'&&<p>Авторское название Atlas. {selected.tags['atlas:type']==='district'?'Границы зоны приблизительные. ':''}Официальное название не подтверждено.</p>}{selected.tags.opening_hours&&<p><b>Часы работы</b><br/>{selected.tags.opening_hours}</p>}{(selected.tags.phone||selected.tags['contact:phone'])&&<p><b>Телефон</b><br/><a href={'tel:'+(selected.tags.phone||selected.tags['contact:phone'])}>{selected.tags.phone||selected.tags['contact:phone']}</a></p>}{(selected.tags['atlas:road-id']||/^(node|way|relation)\//.test(selected.id))&&<a className="source" target="_blank" rel="noreferrer" href={'https://www.openstreetmap.org/'+(selected.tags['atlas:road-id']||selected.id)}>Данные источника ↗</a>}</details></div></>}</SheetContent></Sheet><Sheet open={aboutOpen} onOpenChange={setAboutOpen}><SheetContent className="detail"><SheetHeader><SheetTitle className="detail-title">О карте Atlas</SheetTitle><SheetDescription>Карта Таджикистана</SheetDescription></SheetHeader><div className="detail-body"><p>Изображение карты рисуется в браузере из векторных данных: карту можно поворачивать двумя пальцами и наклонять, дома показаны объёмом. Карта, поиск и маршруты используют собственную копию данных. Изменения администратора поступают в реальном времени через Firebase.</p><p>Названия существующих улиц взяты из открытых данных. Проектные названия Atlas и приблизительные зоны микрорайонов отмечены в карточках; они не являются официальным реестром.</p><a href={siteUrl('/street-sources.html')} target="_blank" rel="noreferrer">Источники названий Шайдона ↗</a><p>Контуры зданий Шайдона — <a href="https://github.com/microsoft/GlobalMLBuildingFootprints" target="_blank" rel="noreferrer">Microsoft Global ML Building Footprints</a>, лицензия ODbL. По остальной стране дома взяты из OpenStreetMap, а где там зданий нет — из того же набора Microsoft (выпуск 3 февраля 2026 года). Это машинное распознавание по спутниковым снимкам, а не официальный кадастр: часть домов в наборе отсутствует. Высота съёмкой не измерена: дом показан условной высотой 4 м, если OpenStreetMap не указывает его высоту или этажность, а в Шайдоне — пока этажность не указал администратор. Асфальт и полосы улиц по стране тоже взяты из OpenStreetMap: асфальтом показана улица с твёрдым покрытием в данных, а магистраль без указанного покрытия считается асфальтированной; полосы — из тегов lanes, иначе по одной в каждую сторону. Администратор может изменить любую улицу. Остановки, светофоры, деревья, скамейки, фонтаны, памятники и флагштоки по стране поставлены по данным OpenStreetMap; их объёмные модели упрощённые и повёрнуты к ближайшей улице. Пешеходные дорожки, тротуары, тропы и полевые дороги вблизи тоже нарисованы в масштабе по OpenStreetMap; газоны показаны там, где они отмечены в данных, а недостающие администратор может нарисовать сам. Дорожки, площади, газоны и флагштоки рисует администратор Atlas по наблюдениям на месте; это не официальная схема благоустройства. Номера домов присвоены Atlas по ближайшей улице и официальным адресом не являются.</p><p>Срез данных: 6 сентября 2026 года, дома по стране — 12 сентября 2026 года. 8 002 места, 6 440 домов Шайдона, 4 730 из них с нумерацией по улицам; 133 дома добавлены из выпуска Microsoft от 3 февраля 2026 года. Покрытие и точность зависят от исходных данных.</p><p>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>. Данные распространяются по лицензии ODbL. Выгрузка: <a href="https://download.geofabrik.de/asia/tajikistan.html" target="_blank" rel="noreferrer">Geofabrik</a>.</p><p>Отрисовка: <a href="https://maplibre.org/" target="_blank" rel="noreferrer">MapLibre GL JS</a>, лицензия BSD-3-Clause. Участки карты собираются в браузере из локальных данных Atlas.</p><a href={siteUrl('/atlas-data/LICENSE.txt')} target="_blank" rel="noreferrer">Лицензия данных ↗</a><a href={siteUrl('/admin')}>Панель администратора ↗</a><p>Маршрут приблизительный: учитывает направления дорог, но не пробки и ограничения поворотов. Пешком, на велосипеде и самокате маршрут идёт по тротуарам, дорожкам и улицам, где это разрешено; для автобуса номера линий и расписание пока недоступны, для такси стоимость не рассчитывается. Голосовые подсказки произносит сам телефон. Избранное хранится в текущем браузере.</p></div></SheetContent></Sheet></main>
}




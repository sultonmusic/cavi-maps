import {siteUrl} from '@/lib/site-url';
import {useCallback,useEffect,useMemo,useRef,useState,type MutableRefObject,type PointerEvent as ReactPointerEvent} from 'react';
import {ArrowDownUp,ArrowLeft,ArrowRight,ArrowUp,Bike,Bookmark,Bus,Car,CarTaxiFront,Check,ChevronDown,ChevronLeft,ChevronRight,ChevronUp,Flag,Footprints,LocateFixed,MapPin,Navigation,Scooter,Search,Square,Volume2,VolumeX,X} from 'lucide-react';
import {alongRoute,buildManeuvers,distance,moveTowards,navigationSnapshot,type LatLng} from '@/lib/navigation';
import {MODES,MODE_LABELS,MODE_NETWORK,MODE_SPEEDS,arrivalPhrase,isMode,turnPrompt,type Mode} from '@/lib/travel.mjs';
import {hush,say,speechAvailable} from '@/lib/voice';
import type {AtlasGL,RouteLines} from '@/lib/atlas-gl';
import type {Marker} from 'maplibre-gl';

export type RoutePoint={id:string;lat:number;lon:number;tags:Record<string,string>};
type Route={path:LatLng[];meters:number;seconds:number};
type Fix={point:LatLng;accuracy:number;speed:number|null;heading:number|null;time:number};
type Drive='forward'|'back'|'left'|'right';
type Props={atlasRef:MutableRefObject<AtlasGL|null>;ready:boolean;places:RoutePoint[];saved:string[];destination:RoutePoint|null;open:boolean;onClose:()=>void;onDestinationChange:(p:RoutePoint)=>void;onNavigationChange:(active:boolean)=>void;pickRef:MutableRefObject<((p:RoutePoint)=>boolean)|null>;findHouses:(text:string,limit:number)=>RoutePoint[]};
const pointName=(p:RoutePoint)=>p.tags['name:ru']||p.tags.name||'Точка на карте';
const pointAddress=(p:RoutePoint)=>[p.tags['addr:city'],p.tags['addr:street'],p.tags['addr:housenumber']].filter(Boolean).join(', ');
const metersText=(n:number)=>n<1000?`${Math.max(0,Math.round(n/10)*10)} м`:`${(n/1000).toFixed(1)} км`;
const minutes=(seconds:number)=>Math.max(1,Math.ceil(seconds/60));
function coordinates(text:string):LatLng|null{const m=text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/);if(!m)return null;const a=Number(m[1]),b=Number(m[2]);return Math.abs(a)<=90&&Math.abs(b)<=180?[a,b]:null}
const fromCoordinates=(p:LatLng,label='Точка на карте'):RoutePoint=>({id:`point:${p.join(',')}`,lat:p[0],lon:p[1],tags:{name:label}});
/** The router works in [lat,lon]; GeoJSON wants the other order. */
const toLngLat=(path:LatLng[])=>path.map(([lat,lon])=>[lon,lat]);
/* A demo drive advances a few metres per tick while a direction is held. */
const DEMO_STEP=3,DEMO_TICK=110,DEMO_TURN=18;
const DRIVE_LABELS:Record<Drive,string>={forward:'Вперёд',back:'Назад',left:'Налево',right:'Направо'};

export default function RoutePlanner({atlasRef,ready,places,saved,destination,open,onClose,onDestinationChange,onNavigationChange,pickRef,findHouses}:Props){
 const [origin,setOrigin]=useState<RoutePoint|null>(null),[originText,setOriginText]=useState(''),[editing,setEditing]=useState(false),[picking,setPicking]=useState(false),[savedOnly,setSavedOnly]=useState(false);
 const [routes,setRoutes]=useState<Route[]>([]),[active,setActive]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState(''),[stepsOpen,setStepsOpen]=useState(false);
 const [nav,setNav]=useState<'idle'|'acquiring'|'live'|'demo'|'arrived'>('idle'),[fix,setFix]=useState<Fix|null>(null),[snapshot,setSnapshot]=useState<ReturnType<typeof navigationSnapshot>|null>(null),[following,setFollowing]=useState(true),[now,setNow]=useState(Date.now()),[cacheStatus,setCacheStatus]=useState('');
 const [bannerShown,setBannerShown]=useState(true);
 const [graphProgress,setGraphProgress]=useState<number|null>(null),[locating,setLocating]=useState(false);
 const [snapGaps,setSnapGaps]=useState({start:0,end:0});
 // How the trip is made is asked each time a route is opened; the last answer is offered first.
 const [mode,setMode]=useState<Mode>(()=>{try{const last=localStorage.getItem('atlas-mode');return isMode(last)?last:'car'}catch{return 'car'}}),[modeAsked,setModeAsked]=useState(false);
 const [voiceOn,setVoiceOn]=useState(()=>{try{return localStorage.getItem('atlas-voice')!=='off'}catch{return true}});
 const spoken=useRef<{index:number;stage:number}|null>(null);
 const gpsEpoch=useRef(0),cacheEpoch=useRef(0);
 const worker=useRef<Worker|null>(null),request=useRef(0),watch=useRef<number|null>(null),lines=useRef<RouteLines|null>(null),originMarker=useRef<Marker|null>(null),offRouteCount=useRef(0),lastReroute=useRef(0),progress=useRef<number|undefined>(undefined),alive=useRef(true);
 const demo=useRef<{point:LatLng;heading:number}|null>(null),hold=useRef<number|null>(null);
 const route=routes[active];const maneuvers=useMemo(()=>route?buildManeuvers(route.path):[],[route]);
 const current=useRef({route,destination,maneuvers,nav,following,busy,mode,voiceOn});current.current={route,destination,maneuvers,nav,following,busy,mode,voiceOn};
 const started=nav==='live'||nav==='acquiring'||nav==='demo';
 const stopWatch=useCallback(()=>{gpsEpoch.current++;setLocating(false);if(watch.current!==null){navigator.geolocation?.clearWatch(watch.current);watch.current=null}},[]);
 const stopHold=useCallback(()=>{if(hold.current!==null){clearInterval(hold.current);hold.current=null}},[]);
 const clearProgress=useCallback(()=>{progress.current=undefined;offRouteCount.current=0;setFix(null);setSnapshot(null);atlasRef.current?.setLocationArrow(null);
  if(lines.current){lines.current={...lines.current,accuracy:null};atlasRef.current?.setRoutes(lines.current)}},[atlasRef]);
 const stopNavigation=useCallback(()=>{
  hush();spoken.current=null;request.current++;worker.current?.postMessage({cancel:true});setBusy(false);stopWatch();stopHold();demo.current=null;
  // Routes are invalidated for many reasons; only an actual drive owns the camera.
  const atlas=atlasRef.current;
  if(atlas&&current.current.nav!=='idle'){atlas.setDrivingView(false);atlas.map.keyboard.enable();atlas.map.easeTo({pitch:0,bearing:0,duration:500})}
  setNav('idle');setStatus('');setError('');setFollowing(true);clearProgress()},[stopWatch,stopHold,clearProgress,atlasRef]);
 const invalidateRoutes=useCallback(()=>{cacheEpoch.current++;request.current++;setBusy(false);setRoutes([]);setActive(0);setStepsOpen(false);setStatus('');setError('');setCacheStatus('');stopNavigation()},[stopNavigation]);
 const selectOrigin=useCallback((p:RoutePoint)=>{invalidateRoutes();setOrigin(p);setOriginText(pointName(p));setEditing(false);setPicking(false);setSavedOnly(false)},[invalidateRoutes]);

 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current++;stopWatch();stopHold();worker.current?.terminate();worker.current=null;atlasRef.current?.setRoutes(null);originMarker.current?.remove();atlasRef.current?.setLocationArrow(null)}},[stopWatch,stopHold,atlasRef]);
 useEffect(()=>{onNavigationChange(started)},[started,onNavigationChange]);
 useEffect(()=>{if(!open){invalidateRoutes();setPicking(false);setEditing(false)}},[open,invalidateRoutes]);
 useEffect(()=>{invalidateRoutes()},[destination?.id,destination?.lat,destination?.lon,invalidateRoutes]);
 useEffect(()=>{if(open)setModeAsked(false)},[open]);
 useEffect(()=>{atlasRef.current?.setTravelMode(mode)},[mode,ready,atlasRef]);
 // While point A is missing, a tap on the map fills it in. After that a tap on a greyed
 // alternative promotes it, and a tap anywhere else names a new point Б.
 useEffect(()=>{pickRef.current=p=>{
  if(started)return true;if(!open)return false;
  if(picking||!origin){selectOrigin(p);return true}
  const map=atlasRef.current?.map;
  if(map&&routes.length>1){const at=map.project([p.lon,p.lat]);
   const index=map.queryRenderedFeatures([[at.x-12,at.y-12],[at.x+12,at.y+12]],{layers:['route-alt']})[0]?.properties?.index;
   if(typeof index==='number'){chooseRoute(index);return true}}
  return false};return()=>{pickRef.current=null}},[pickRef,open,picking,started,selectOrigin,origin,routes,atlasRef]);
 useEffect(()=>{if(!started)return;const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id)},[started]);
 // The status line announces a change, then gets out of the way of the road.
 useEffect(()=>{if(!started&&nav!=='arrived')return;setBannerShown(true);const id=setTimeout(()=>setBannerShown(false),3500);return()=>clearTimeout(id)},[status,nav,started]);
 useEffect(()=>{const atlas=atlasRef.current;if(!ready||!atlas)return;const handler=()=>{if(current.current.nav!=='idle')setFollowing(false)};atlas.map.on('dragstart',handler);return()=>{atlas.map.off('dragstart',handler)}},[ready,atlasRef]);
 useEffect(()=>{originMarker.current?.remove();originMarker.current=null;const atlas=atlasRef.current;if(!open||!origin||!ready||!atlas)return;
  originMarker.current=atlas.marker('<span class="route-pin route-pin-a">А</span>','route-pin-wrap').setLngLat([origin.lon,origin.lat]).addTo(atlas.map)},[origin,open,ready,atlasRef]);
 useEffect(()=>{
  const atlas=atlasRef.current;
  if(!open||!ready||!atlas||!route){atlas?.setRoutes(null);lines.current=null;return}
  const tail=route.path[route.path.length-1];
  const next:RouteLines={
   variants:started?[toLngLat(route.path)]:routes.map(variant=>toLngLat(variant.path)),
   active:started?0:active,
   remaining:started?toLngLat(route.path):null,
   running:started,
   connector:destination&&distance(tail,[destination.lat,destination.lon])>15?toLngLat([tail,[destination.lat,destination.lon]]):null,
   accuracy:null,
  };
  lines.current=next;atlas.setRoutes(next);
  // Right padding clears the zoom controls, so point Б never hides under them.
  if(!started){const height=atlas.map.getCanvas().clientHeight||500;
   atlas.fit(toLngLat(route.path),{top:65,bottom:Math.min(height*.48,340),left:45,right:90},17)}
  return()=>{atlasRef.current?.setRoutes(null);lines.current=null};
 },[routes,active,open,ready,atlasRef,started,route,destination]);
 // Arrow keys and WASD drive the demo on a computer.
 useEffect(()=>{if(nav!=='demo')return;
  const keys:Record<string,Drive>={ArrowUp:'forward',KeyW:'forward',ArrowDown:'back',KeyS:'back',ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right'};
  const down=(event:KeyboardEvent)=>{const kind=keys[event.code];if(!kind)return;const target=event.target as HTMLElement|null;
   if(target&&/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))return;event.preventDefault();setFollowing(true);demoMove(kind)};
  const up=(event:KeyboardEvent)=>{if(keys[event.code])setFix(value=>value?{...value,speed:0}:value)};
  window.addEventListener('keydown',down);window.addEventListener('keyup',up);
  return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up)}},[nav]);
 // Start fetching the road network as soon as a route is being planned, so the first build does not wait for it.
 useEffect(()=>{if(open)routeWorker().postMessage({warm:true})},[open]);
 // Most trips start where you are: point A comes from GPS whenever the browser allows it.
 useEffect(()=>{
  if(!open||origin||!window.isSecureContext||!navigator.geolocation)return;
  let live=true;const locate=()=>{if(live)useLocation(true)};
  const asked=navigator.permissions?.query({name:'geolocation'});
  if(asked)asked.then(result=>{if(result.state!=='denied')locate()},locate);else locate();
  return()=>{live=false};
 },[open,destination?.id]);
 // With both ends known the route is built at once; there is no button to press.
 useEffect(()=>{if(open&&modeAsked&&origin&&destination&&!started&&nav!=='arrived'&&!routes.length&&!busy&&!error&&!editing&&!picking)calculate(origin,destination)},[open,modeAsked,origin,destination,started,nav,routes.length,busy,error,editing,picking]);

 /** One routing worker per session. While it loads the road network it reports progress, without a request id. */
 function routeWorker(){
  if(worker.current)return worker.current;
  const created=new Worker(siteUrl('/route-worker.js'));
  created.onmessage=({data})=>{if(alive.current&&typeof data?.progress==='number')setGraphProgress(data.progress)};
  worker.current=created;return created;
 }
 function calculate(start:RoutePoint,end:RoutePoint,recalculating=false){
  const id=++request.current;setBusy(true);setError('');setStatus(recalculating?'Вы отклонились от маршрута. Перестраиваем…':'Строим маршруты по местным дорогам…');setCacheStatus('');
  const routing=routeWorker();
  routing.onmessage=({data})=>{
   if(!alive.current)return;
   if(typeof data?.progress==='number'){setGraphProgress(data.progress);return}
   if(data.id!==request.current)return;setBusy(false);
   if(data.error){setError(data.error);setStatus('');return}
   const next:Route[]=data.routes;spoken.current=null;setGraphProgress(1);setSnapGaps({start:data.startGap||0,end:data.endGap||0});setRoutes(next);setActive(0);setStepsOpen(false);setStatus(recalculating?'Маршрут перестроен':next.length===1?'Найден один подходящий маршрут':`Найдено вариантов: ${next.length}`);progress.current=undefined;offRouteCount.current=0;
   if(recalculating){setOrigin(start);setOriginText('Текущее местоположение')}
   void cacheRoute(next[0]);
  };
  routing.onerror=()=>{if(id!==request.current)return;setBusy(false);setError('Не удалось рассчитать маршрут. Попробуйте ещё раз.');setStatus('')};
  const how=current.current.mode;
  routing.postMessage({id,start:[start.lat,start.lon],end:[end.lat,end.lon],maxRoutes:recalculating?1:3,network:MODE_NETWORK[how],speed:MODE_SPEEDS[how]});
 }
 async function cacheRoute(r:Route){
  const epoch=++cacheEpoch.current;const valid=()=>alive.current&&epoch===cacheEpoch.current;
  if(!navigator.serviceWorker||!window.isSecureContext)return;
  try{
   const registration=await navigator.serviceWorker.ready;if(!valid())return;const target=navigator.serviceWorker.controller||registration.active;if(!target)return;
   const groups=new Set<string>();
   for(const z of [7,10,13]){const n=2**z;let previous:number[]|null=null;for(const [lat,lon] of r.path){const p=[(lon+180)/360*n,(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n];const steps=previous?Math.max(1,Math.ceil(Math.max(Math.abs(p[0]-previous[0]),Math.abs(p[1]-previous[1])))):1;for(let k=0;k<=steps;k++){const x=Math.floor(previous?previous[0]+(p[0]-previous[0])*k/steps:p[0]),y=Math.floor(previous?previous[1]+(p[1]-previous[1])*k/steps:p[1]);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)groups.add(`/atlas-data/bundle-${z}-${Math.floor((x+dx)/4)}-${Math.floor((y+dy)/4)}.json`)}previous=p}}
   const meta=await (await fetch(siteUrl('/atlas-data/index.json'))).json();const available=new Set<string>(meta.tiles.map((t:string)=>{const [z,x,y]=t.slice(0,-5).split('-').map(Number);return `/atlas-data/bundle-${z}-${Math.floor(x/4)}-${Math.floor(y/4)}.json`}));
   const graph=await (await fetch(siteUrl('/road-graph.json'))).json();const urls=[...groups].filter(g=>available.has(g));urls.push('/road-graph.json',...(graph.nodes_files||[]),...(graph.edges_files||[]));
   if(!valid())return;setCacheStatus('Сохраняем карту вдоль маршрута…');const channel=new MessageChannel();
   const result:any=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),120000);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(e.data)};target.postMessage({type:'CACHE_URLS',urls},[channel.port2])});
   if(valid())setCacheStatus(result.ok?'Карта маршрута сохранена на устройстве':'Часть карты не сохранена. Нужна связь с интернетом.');
  }catch{if(valid())setCacheStatus('Для новых участков карты нужна связь с интернетом.')}
 }
 function chooseRoute(index:number){setActive(index);progress.current=undefined;void cacheRoute(routes[index])}
 /** Point A from GPS. Quiet when nobody pressed for it: a refusal then simply leaves A to the reader. */
 function useLocation(quiet=false){
  if(!window.isSecureContext){if(!quiet)setError('Для GPS откройте карту по HTTPS.');return}
  if(!navigator.geolocation){if(!quiet)setError('Этот браузер не поддерживает GPS. Укажите точку на карте.');return}
  // The route that follows is fitted to both ends, so the map does not jump to A first.
  const epoch=++gpsEpoch.current;setLocating(true);navigator.geolocation.getCurrentPosition(p=>{if(!alive.current||epoch!==gpsEpoch.current)return;setLocating(false);selectOrigin(fromCoordinates([p.coords.latitude,p.coords.longitude],'Моё местоположение'))},e=>{if(!alive.current||epoch!==gpsEpoch.current)return;setLocating(false);if(!quiet)setError(e.code===1?'Разрешите доступ к местоположению в настройках браузера.':'Не удалось определить местоположение. Выберите точку на карте.')},{enableHighAccuracy:true,timeout:15000,maximumAge:5000});
 }
 function showRouteOverview(){
  const atlas=atlasRef.current;if(!route||!atlas)return;
  atlas.map.jumpTo({pitch:0,bearing:0});
  atlas.fit(toLngLat(route.path),{top:170,bottom:230,left:40,right:90},17);
 }
 function overview(){setFollowing(false);showRouteOverview()}
 /** A driver's camera: tilted steeply to see far down the road, turned to the direction of travel, the arrow low on screen. */
 function follow(here:[number,number],heading:number|null,duration:number){
  const atlas=atlasRef.current;if(!atlas)return;
  const height=atlas.map.getCanvas().clientHeight||600;
  atlas.map.easeTo({center:here,bearing:heading??atlas.map.getBearing(),pitch:70,
   zoom:Math.min(19,Math.max(16.5,atlas.map.getZoom())),offset:[0,height*0.2],duration,easing:t=>t});
 }
 /** One position update, from the real GPS or from the demo controls. */
 function applyFix(fresh:Fix,simulated:boolean){
  const c=current.current;if(!c.route||!c.destination)return;
  setFix(fresh);setNow(fresh.time);setNav(simulated?'demo':'live');
  const atlas=atlasRef.current,point=fresh.point;
  if(atlas){const here:[number,number]=[point[1],point[0]];
   atlas.setLocationArrow({lon:here[0],lat:here[1],heading:fresh.heading});
   if(lines.current){lines.current={...lines.current,accuracy:simulated?null:{centre:here,radius:fresh.accuracy}};atlas.setRoutes(lines.current)}
   if(c.following)follow(here,fresh.heading,simulated?DEMO_TICK:900)}
  if(!simulated&&fresh.accuracy>80){setStatus(`Слабый сигнал GPS · точность ±${Math.round(fresh.accuracy)} м`);return}
  const s=navigationSnapshot(point,c.route.path,c.maneuvers,progress.current);if(!s.valid)return;setSnapshot(s);progress.current=s.progressMeters;
  // Spoken prompts: once far out, once close in and once at each turn.
  if(!s.arrived&&s.nextManeuver){const prompt=turnPrompt(s.nextManeuver.kind,s.metersToManeuver,c.mode),last=spoken.current;
   if(prompt&&(!last||last.index!==s.nextManeuver.index||prompt.stage>last.stage)){spoken.current={index:s.nextManeuver.index,stage:prompt.stage};if(c.voiceOn)say(prompt.text)}}
  if(lines.current){lines.current={...lines.current,remaining:toLngLat([s.point,...c.route.path.slice(s.segmentIndex+1)])};atlasRef.current?.setRoutes(lines.current)}
  if(s.arrived){stopWatch();stopHold();setNav('arrived');const gap=distance(point,[c.destination.lat,c.destination.lon]);if(c.voiceOn)say(arrivalPhrase(gap<=50));setStatus(gap<=50?'Вы прибыли к точке Б':`Конец маршрута. До точки Б ещё ${metersText(gap)}`);return}
  const limit=simulated?25:Math.max(60,fresh.accuracy*1.5);
  if(s.offRouteMeters>limit){
   offRouteCount.current++;setStatus('Вы вне маршрута');
   if(offRouteCount.current>=(simulated?4:2)&&!c.busy&&Date.now()-lastReroute.current>(simulated?6000:20000)){lastReroute.current=Date.now();if(c.voiceOn)say('Маршрут перестраивается');calculate(fromCoordinates(point,'Текущее местоположение'),c.destination,true)}
  }else{if(offRouteCount.current)setStatus(simulated?'Снова на маршруте':'GPS активен');offRouteCount.current=0;setError('')}
 }
 /** Without GPS the drive becomes a demo you steer yourself. */
 function startDemo(reason:string){
  const c=current.current;if(!c.route)return;
  stopWatch();stopHold();
  const resume=demo.current;
  const start=resume?{point:resume.point,heading:resume.heading}:alongRoute(c.route.path,0);if(!start)return;
  if(!resume){clearProgress();lastReroute.current=0}
  demo.current={point:start.point,heading:start.heading};offRouteCount.current=0;
  setStepsOpen(false);setError('');setFollowing(true);current.current={...current.current,following:true};
  setStatus(`${reason} · демо-поездка`);
  if(current.current.voiceOn&&!resume)say('Двигайтесь по маршруту');
  const atlas=atlasRef.current;
  if(atlas){atlas.setDrivingView(true);atlas.map.keyboard.disable();if(!resume)atlas.map.jumpTo({zoom:18})}
  applyFix({point:start.point,accuracy:5,speed:0,heading:start.heading,time:Date.now()},true);
 }
 function demoMove(kind:Drive){
  const c=current.current,state=demo.current;if(!c.route||!state||c.nav==='arrived')return;
  let {point,heading}=state;
  const s=navigationSnapshot(point,c.route.path,c.maneuvers,progress.current);
  const onRoute=s.valid&&s.offRouteMeters<12;
  // A demo walk or ride moves at its own pace.
  const pace=c.mode==='foot'?0.6:MODE_NETWORK[c.mode]==='bike'?1.4:DEMO_STEP;
  if(kind==='forward'||kind==='back'){
   const step=kind==='forward'?pace:-pace;
   // On the route, forward follows it round every corner; off it, forward is straight ahead.
   const along=onRoute?alongRoute(c.route.path,s.progressMeters+step):null;
   if(along){point=along.point;heading=along.heading}
   else point=moveTowards(point,heading,step);
  }else{
   heading=(heading+(kind==='left'?-DEMO_TURN:DEMO_TURN)+360)%360;
   point=moveTowards(point,heading,pace);
  }
  demo.current={point,heading};
  applyFix({point,accuracy:5,speed:pace/(DEMO_TICK/1000),heading,time:Date.now()},true);
 }
 function driveStart(kind:Drive,event:ReactPointerEvent<HTMLButtonElement>){
  event.preventDefault();
  stopHold();setFollowing(true);current.current={...current.current,following:true};
  // Move first: capture is a nicety that some browsers refuse, and a refusal
  // must never leave the pad dead.
  demoMove(kind);hold.current=window.setInterval(()=>demoMove(kind),DEMO_TICK);
  try{event.currentTarget.setPointerCapture(event.pointerId)}catch{}
 }
 function driveStop(){if(hold.current===null)return;stopHold();setFix(value=>value?{...value,speed:0}:value)}
 function startNavigation(){
  if(!route||!destination)return;
  if(!window.isSecureContext){startDemo('Для GPS нужен HTTPS');return}
  if(!navigator.geolocation){startDemo('GPS недоступен');return}
  const listen=()=>{
   const resume=demo.current;
   stopWatch();stopHold();if(!resume)clearProgress();
   setStepsOpen(false);setError('');setFollowing(true);setNow(Date.now());lastReroute.current=0;
   if(!resume){setNav('acquiring');setStatus('Запрашиваем GPS · маршрут уже доступен');atlasRef.current?.setDrivingView(true);showRouteOverview()}
   else setStatus('Запрашиваем GPS…');
   const epoch=++gpsEpoch.current;
   try{watch.current=navigator.geolocation.watchPosition(p=>{
     if(!alive.current||epoch!==gpsEpoch.current)return;
     demo.current=null;atlasRef.current?.map.keyboard.enable();
     applyFix({point:[p.coords.latitude,p.coords.longitude],accuracy:p.coords.accuracy,
      speed:p.coords.speed!==null&&Number.isFinite(p.coords.speed)?p.coords.speed:null,
      heading:p.coords.heading!==null&&Number.isFinite(p.coords.heading)?p.coords.heading:null,time:Date.now()},false);
    },e=>{if(!alive.current||epoch!==gpsEpoch.current)return;startDemo(e.code===1?'Доступ к GPS не разрешён':'Сигнал GPS недоступен')},
    {enableHighAccuracy:true,maximumAge:2000,timeout:15000})}
   catch{startDemo('GPS недоступен')}
  };
  // A permission already refused never prompts again, so go straight to the demo.
  const permissions=navigator.permissions;
  if(permissions?.query)permissions.query({name:'geolocation'}).then(result=>result.state==='denied'?startDemo('Доступ к GPS не разрешён'):listen()).catch(listen);
  else listen();
 }
 /** A new way of travel needs routes of its own, so any built for the last one are dropped. */
 function chooseMode(value:Mode){
  try{localStorage.setItem('atlas-mode',value)}catch{}
  const changed=value!==mode;setMode(value);setModeAsked(true);current.current={...current.current,mode:value};
  if(changed&&routes.length)invalidateRoutes();
 }
 function toggleVoice(){
  const next=!voiceOn;setVoiceOn(next);current.current={...current.current,voiceOn:next};
  try{localStorage.setItem('atlas-voice',next?'on':'off')}catch{}
  if(next)say('Голосовые подсказки включены');else hush();
 }
 function modeIcon(value:Mode,size:number){return value==='foot'?<Footprints size={size}/>:value==='bike'?<Bike size={size}/>:value==='scooter'?<Scooter size={size}/>:value==='bus'?<Bus size={size}/>:value==='taxi'?<CarTaxiFront size={size}/>:<Car size={size}/>}
 function close(){request.current++;stopNavigation();setRoutes([]);setOrigin(null);setOriginText('');setPicking(false);setEditing(false);onClose()}
 // Named places first, then houses by street and number.
 const choices=useMemo(()=>{const q=originText.toLocaleLowerCase('ru').trim();const named=places.filter(p=>(!savedOnly||saved.includes(p.id))&&(!q||`${pointName(p)} ${pointAddress(p)}`.toLocaleLowerCase('ru').includes(q)));const houses=savedOnly||q.length<2?[]:findHouses(originText,8);return [...named.slice(0,houses.length?5:8),...houses].slice(0,8)},[places,originText,savedOnly,saved,findHouses]);
 if(!open||!destination)return null;
 const loadingRoads=graphProgress!==null&&graphProgress<1,roadsPercent=Math.round((graphProgress??0)*100);
 const atDestination=!!fix&&distance(fix.point,[destination.lat,destination.lon])<=50;
 const stale=nav==='live'&&!!fix&&now-fix.time>15000;const remaining=snapshot?.remainingMeters??route?.meters??0;const seconds=route?route.seconds*(remaining/Math.max(1,route.meters)):0;const arrival=new Date(now+seconds*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
 const moving=nav==='live'||nav==='demo';
 const displayedKind=snapshot?.nextManeuver?.kind;
 const driveIcon=(kind:Drive)=>kind==='forward'?<ChevronUp size={30}/>:kind==='back'?<ChevronDown size={30}/>:kind==='left'?<ChevronLeft size={30}/>:<ChevronRight size={30}/>;
 if(started||nav==='arrived')return <>
  <div className={'gps-status '+(nav==='demo'?'gps-manual':stale||(nav==='live'&&(!fix||fix.accuracy>80))?'gps-weak':'')+(!bannerShown&&!busy?' is-hidden':'')} role="status"><span className="live-dot"/><span>{stale?'Сигнал GPS потерян. Ожидаем обновление…':status}</span>{busy&&<span className="mini-spinner"/>}</div>
  <div className="maneuver-card" aria-live="polite">{nav==='arrived'?<Check size={26}/>:displayedKind==='left'?<ArrowLeft size={26}/>:displayedKind==='right'?<ArrowRight size={26}/>:displayedKind==='uturn'?<ArrowDownUp size={26}/>:displayedKind==='arrive'?<Flag size={26}/>:<ArrowUp size={26}/>}<div><strong>{nav==='arrived'?(atDestination?'Вы на месте':'Конец маршрута'):snapshot?metersText(snapshot.metersToManeuver):nav==='acquiring'?'GPS':'—'}</strong><span>{nav==='arrived'?(atDestination?pointName(destination):`До точки Б ещё ${metersText(distance(fix!.point,[destination.lat,destination.lon]))}`):snapshot?.instruction||(nav==='acquiring'?'Определяем местоположение':'Двигайтесь прямо')}</span></div></div>
  {moving&&!following&&<button className="follow-position" onClick={()=>{setFollowing(true);if(fix)follow([fix.point[1],fix.point[0]],fix.heading,500)}}><LocateFixed size={20}/>Вернуть к себе</button>}
  {nav==='demo'&&<div className="demo-pad" role="group" aria-label="Демо-управление" onContextMenu={event=>event.preventDefault()}>
   <span className="demo-pad-label">ДЕМО</span>
   {(['forward','left','right','back'] as Drive[]).map(kind=><button key={kind} type="button" className={'demo-'+kind} aria-label={DRIVE_LABELS[kind]} onPointerDown={event=>driveStart(kind,event)} onPointerUp={driveStop} onPointerCancel={driveStop} onLostPointerCapture={driveStop}>{driveIcon(kind)}</button>)}
  </div>}
  <section className="navigation-dock" aria-label="Навигация">
   <div className="trip-stats"><div><strong>{nav==='arrived'?0:minutes(seconds)}</strong><span>мин · оценка</span></div><div><strong>{arrival}</strong><span>прибытие</span></div><div><strong>{metersText(remaining)}</strong><span>осталось</span></div><div><strong>{fix?.speed!=null?Math.round(fix.speed*3.6):'—'}</strong><span>{nav==='demo'?'км/ч · демо':'км/ч'}</span></div></div>
   <div className="trip-actions"><button onClick={()=>setStepsOpen(!stepsOpen)}><Navigation size={18}/>Шаги</button><button onClick={overview}><MapPin size={18}/>Обзор</button>{nav==='demo'&&<button onClick={startNavigation}><LocateFixed size={18}/>GPS</button>}{nav==='acquiring'&&<button onClick={()=>startDemo('Без GPS')}><Car size={18}/>Демо</button>}{speechAvailable()&&<button className={voiceOn?'voice-toggle':'voice-toggle off'} aria-pressed={voiceOn} onClick={toggleVoice}>{voiceOn?<Volume2 size={18}/>:<VolumeX size={18}/>}Голос</button>}<button className="stop-navigation" onClick={stopNavigation}><Square size={16}/>{nav==='arrived'?'Завершить':'Стоп'}</button></div>
   {stepsOpen&&<ol className="turn-list">{maneuvers.map((m,i)=><li key={i}><span>{m.instruction}</span><small>{metersText(m.metersFromStart)}</small></li>)}</ol>}
  </section>
 </>;
 if(!modeAsked)return <section className="route-planner mode-chooser" aria-label="Способ передвижения">
  <div className="sheet-handle"/><div className="planner-title"><h2>Как добираться?</h2><button aria-label="Закрыть маршрут" onClick={close}><X size={21}/></button></div>
  <p className="planner-status">До точки «{pointName(destination)}»</p>
  <div className="mode-grid">{MODES.map(value=><button key={value} className={mode===value?'chosen':''} onClick={()=>chooseMode(value)}>{modeIcon(value,24)}<span>{MODE_LABELS[value]}</span></button>)}</div>
 </section>;
 return <section className={'route-planner '+(editing?'editing-origin':'')+(picking?' picking-origin':'')} aria-label="Маршрут">
  <div className="sheet-handle"/><div className="planner-title"><h2>{routes.length&&!editing?MODE_LABELS[mode]:'Маршрут'}</h2><button aria-label="Закрыть маршрут" onClick={close}><X size={21}/></button></div>
  {!picking&&<div className="mode-chips" role="radiogroup" aria-label="Способ передвижения">{MODES.map(value=><button key={value} role="radio" aria-checked={mode===value} className={mode===value?'chosen':''} onClick={()=>chooseMode(value)}>{modeIcon(value,15)}{MODE_LABELS[value]}</button>)}</div>}
  {picking?<div className="pick-origin-message"><MapPin size={24}/><strong>Нажмите на карту: точка А</strong><button onClick={()=>{setPicking(false);setEditing(true)}}>Ввести адрес</button></div>:<>
   {!!routes.length&&!editing?<div className="route-summary"><span title={`${origin?pointName(origin):'А'} → ${pointName(destination)}`}><span className="endpoint-dot a">А</span>{origin?pointName(origin):'Откуда'}<ArrowRight size={15}/>{pointName(destination)}</span><button onClick={()=>setEditing(true)}>Изменить</button></div>:<>
   <div className="route-endpoints"><label className="endpoint-row"><span className="endpoint-dot a">А</span><input aria-label="Откуда поедем" placeholder={locating?'Определяем местоположение…':'Откуда? Адрес или точка на карте'} value={originText} onFocus={()=>setEditing(true)} onChange={e=>{setOriginText(e.target.value);setOrigin(null);setEditing(true);invalidateRoutes()}} onKeyDown={e=>{if(e.key==='Enter'){const p=coordinates(originText);if(p)selectOrigin(fromCoordinates(p,originText));else if(choices[0])selectOrigin(choices[0])}}}/>{originText&&<button aria-label="Очистить точку А" onClick={()=>{setOriginText('');setOrigin(null);invalidateRoutes();setEditing(true)}}><X size={16}/></button>}</label><div className="endpoint-row"><span className="endpoint-dot b">Б</span><span className="destination-name">{pointName(destination)}</span><button aria-label="Поменять точки местами" disabled={!origin} onClick={()=>{if(!origin)return;const prev=origin;selectOrigin(destination);onDestinationChange(prev)}}><ArrowDownUp size={20}/></button></div></div>
   {(editing||!origin)&&<div className="origin-picker"><div className="origin-actions"><button onClick={()=>useLocation()}><LocateFixed size={17}/>Я здесь</button><button onClick={()=>{setPicking(true);setEditing(false)}}><MapPin size={17}/>На карте</button><button className={savedOnly?'active':''} onClick={()=>{setSavedOnly(!savedOnly);setOriginText('');setOrigin(null);invalidateRoutes();setEditing(true)}}><Bookmark size={17}/>Избранное</button></div>{coordinates(originText)&&<button className="origin-result" onClick={()=>selectOrigin(fromCoordinates(coordinates(originText)!,originText))}><MapPin size={18}/><span>Использовать координаты<br/><small>{originText}</small></span></button>}{(originText.length>1||savedOnly)&&<div className="origin-results">{choices.map(p=><button className="origin-result" key={p.id} onClick={()=>selectOrigin(p)}><Search size={17}/><span>{pointName(p)}<small>{pointAddress(p)||`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`}</small></span></button>)}{!choices.length&&!coordinates(originText)&&<p>Нет совпадений. Выберите точку на карте или введите координаты.</p>}</div>}</div>}
   {!!routes.length&&editing&&<button className="build-route" onClick={()=>setEditing(false)}>Готово</button>}
   </>}
  </>}
  {(busy||(loadingRoads&&!routes.length))&&<div className="route-progress" role="status"><span className="mini-spinner"/><span>{loadingRoads?`Загружаем дороги · ${roadsPercent}%`:'Строим маршрут…'}</span>{loadingRoads&&<i><b style={{width:`${roadsPercent}%`}}/></i>}</div>}
  {error&&<div className="planner-error" role="alert">{error}{error.includes('GPS')&&<a href={siteUrl('/gps-help.html')} target="_blank" rel="noreferrer">Как включить GPS ↗</a>}{origin&&!busy&&<button onClick={()=>setError('')}>Повторить</button>}</div>}
  {status&&!busy&&!routes.length&&<p className="planner-status" role="status">{status}</p>}
  {!!routes.length&&!editing&&!picking&&<><div className="route-variants" role="group" aria-label="Варианты маршрута">{routes.map((r,i)=><button key={i} className={'route-option '+(active===i?'selected':'')} aria-pressed={active===i} onClick={()=>chooseRoute(i)}><span className="variant-name">{i===0?'Самый короткий':`Вариант ${i+1}`}</span><strong>{minutes(r.seconds)} <small>мин</small></strong><span>{metersText(r.meters)}</span></button>)}</div><div className="preview-actions"><button onClick={()=>setStepsOpen(!stepsOpen)}><Navigation size={19}/>Шаги</button><button className="start-navigation" disabled={busy} onClick={startNavigation}><Navigation size={20}/>В путь</button></div><details className="route-details"><summary>О маршруте</summary><p className="estimate-note">Время приблизительное, без пробок и ограничений поворотов.</p>{mode==='bus'&&<p className="estimate-note">Номера автобусов и расписание пока недоступны: время оценено по дорогам при средней скорости автобуса.</p>}{mode==='taxi'&&<p className="estimate-note">Стоимость поездки не рассчитывается.</p>}{MODE_NETWORK[mode]!=='car'&&<p className="estimate-note">Маршрут проложен по тротуарам, дорожкам и улицам, где это разрешено.</p>}{(snapGaps.start>30||snapGaps.end>30)&&<p className="estimate-note">{snapGaps.start>30?`От А до дороги: ${metersText(snapGaps.start)}. `:""}{snapGaps.end>30?`От дороги до Б: ${metersText(snapGaps.end)}. Подъезд не найден.`:""}</p>}{cacheStatus&&<p className="cache-status">{cacheStatus}</p>}</details>{stepsOpen&&<ol className="turn-list">{maneuvers.map((m,i)=><li key={i}><span>{m.instruction}</span><small>{metersText(m.metersFromStart)}</small></li>)}</ol>}</>}
 </section>;
}

'use client';
// The Profile tab: brand, the reader's places (home, work, favourites), recent places and routes,
// the map saved for use without internet, settings, the app and the admin link. There are no
// accounts: everything is kept on this device by lib/profile-store.ts and lib/offline-maps.ts.
// Only native <select> and switch buttons are used inside the Sheet: the shadcn Select popup opens
// at z-index 50, behind the Sheet at 1000.
import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {Bike,Bookmark,Briefcase,Building2,Bus,Car,CarTaxiFront,Clock,Download,Footprints,HardDrive,House,Info,LocateFixed,MapPin,MapPinned,Rotate3d,Route,Scooter,Share2,ShieldCheck,Signpost,Smartphone,Trash2,Volume2,X,type LucideIcon} from 'lucide-react';
import {Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import CaviMark from '@/components/cavi-mark';
import {APP_NAME,APP_BYLINE,APP_VERSION} from '@/lib/brand.mjs';
import {CITIES,REGIONS,cityAt,cityByName} from '@/lib/cities.mjs';
import {kindLabel,PLACE_KIND_LABELS} from '@/lib/place-kinds.mjs';
import {plural,distanceLabel,type SearchPlace} from '@/lib/place-search';
import {MODES,MODE_LABELS,type Mode} from '@/lib/travel.mjs';
import {readPrefs,writePrefs,readVoice,writeVoice,readBuildingDetail,writeBuildingDetail,readMode,writeMode,recentPlaces,recentRoutes,clearHistory,homePlace,setHomePlace,onProfileChange,type HomeSlot,type Prefs,type RecentPlace,type RecentRoute,type StoredPlace} from '@/lib/profile-store';
import {offlineSupported,offlineStatus,planArea,planGraph,saveUrls,clearSavedMaps,savedAreas,rememberArea,forgetAreas,buildInfo,type OfflineStatus,type SavedArea} from '@/lib/offline-maps';
import {cityArea,viewArea,formatBytes,type OfflineArea} from '@/lib/offline-areas.mjs';
import {siteUrl,SITE_ROOT} from '@/lib/site-url';

export type LiveState={connected:boolean;ready:boolean;error?:string|null};
type Props={
 open:boolean;onClose():void;
 /** Ids of the favourites, oldest first (the page's atlas-saved). */
 saved:string[];placeById(id:string):SearchPlace|undefined;
 onOpenPlace(p:SearchPlace):void;onRoute(p:SearchPlace):void;onToggleSaved(p:SearchPlace):void;
 onShowFavourites():void;onPickHome(slot:HomeSlot):void;
 viewCity:string;mapCentre:[lon:number,lat:number];
 onAbout():void;
 live:LiveState;
};

/** The footer line about live map updates, in words a reader understands. */
export function liveLabel(live:{connected:boolean;ready:boolean}):string{
 return live.connected?'● Карта обновляется онлайн':live.ready?'○ Без связи — показаны сохранённые данные':'Подключение…';
}

const MODE_ICONS:Record<Mode,LucideIcon>={foot:Footprints,bike:Bike,scooter:Scooter,car:Car,bus:Bus,taxi:CarTaxiFront};
/** Areas bigger than this ask before downloading: people are often on mobile data. */
const ASK_ABOVE=30*1024*1024;
const COUNTRY_REGIONS=REGIONS.filter(region=>region!=='Вся страна');

type Snapshot={prefs:Prefs;voice:boolean;detail:boolean;mode:Mode;home:StoredPlace|null;work:StoredPlace|null;places:RecentPlace[];routes:RecentRoute[];areas:SavedArea[]};
function readAll():Snapshot{
 return {prefs:readPrefs(),voice:readVoice(),detail:readBuildingDetail(),mode:readMode(),home:homePlace('home'),work:homePlace('work'),places:recentPlaces(),routes:recentRoutes(),areas:savedAreas()};
}
/** Everything the page shows from the device, re-read on every change and whenever the page opens. */
function useProfile(open:boolean){
 const [snap,setSnap]=useState(readAll);
 useEffect(()=>onProfileChange(()=>setSnap(readAll())),[]);
 useEffect(()=>{if(open)setSnap(readAll())},[open]);
 return snap;
}
function useOnline(){
 const [online,setOnline]=useState(()=>typeof navigator==='undefined'||navigator.onLine!==false);
 useEffect(()=>{const on=()=>setOnline(true),off=()=>setOnline(false);
  window.addEventListener('online',on);window.addEventListener('offline',off);
  return()=>{window.removeEventListener('online',on);window.removeEventListener('offline',off)}},[]);
 return online;
}
function isStandalone(){
 try{return window.matchMedia('(display-mode: standalone)').matches||(navigator as Navigator&{standalone?:boolean}).standalone===true}catch{return false}
}
type InstallPrompt=Event&{prompt():Promise<void>;userChoice?:Promise<{outcome:string}>};

function placeTitle(p:SearchPlace){return p.tags['name:ru']||p.tags.name||p.tags['name:en']||'Точка на карте'}
function placeKind(p:SearchPlace){
 const t=p.tags,type=t['atlas:type'];
 if(type==='label')return PLACE_KIND_LABELS[t['atlas:place']]||'Место';
 if(type==='street')return 'Улица';
 if(type==='route')return 'Дорога';
 if(type==='district')return 'Микрорайон';
 if(type==='house')return t['atlas:house']?'Дом':'Здание';
 if(p.id.startsWith('point:'))return 'Место на карте';
 if(p.id.startsWith('coord:'))return 'Координаты';
 return kindLabel(t);
}
/** The town a place is in, when it is in one. */
function placeTown(p:SearchPlace){
 const town=cityAt(p.lat,p.lon)?.name;
 if(town)return town;
 const city=p.tags['addr:city'];
 return city&&!city.startsWith('Таджикистан')?city:'';
}
function placeAddress(p:SearchPlace){
 const t=p.tags;
 const street=[t['addr:street']||t['atlas:street'],t['addr:housenumber']||t['atlas:house']].filter(Boolean).join(', ');
 return [street,placeTown(p)].filter(Boolean).join(' · ');
}
function durationLabel(seconds:number){
 const minutes=Math.max(1,Math.ceil(seconds/60));
 if(minutes<60)return `${minutes} мин`;
 const hours=Math.floor(minutes/60),rest=minutes%60;
 return rest?`${hours} ч ${rest} мин`:`${hours} ч`;
}
function dayLabel(iso:string){
 const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
 return m?`${m[3]}.${m[2]}.${m[1]}`:iso;
}

function Section({title,children}:{title:string;children:ReactNode}){
 const id=useId();
 return <section className="profile-section" aria-labelledby={id}><h3 id={id}>{title}</h3>{children}</section>;
}
function Text({title,hint}:{title:ReactNode;hint?:ReactNode}){
 return <span>{title}{hint?<small>{hint}</small>:null}</span>;
}
function SwitchRow({Icon,title,hint,on,disabled,onToggle}:{Icon:LucideIcon;title:string;hint:string;on:boolean;disabled?:boolean;onToggle(next:boolean):void}){
 return <button type="button" role="switch" aria-checked={on} disabled={disabled} className="profile-item profile-toggle" onClick={()=>onToggle(!on)}>
  <Icon size={20} aria-hidden="true"/><Text title={title} hint={hint}/><i className="profile-switch" aria-hidden="true"/>
 </button>;
}
function CityOptions(){
 return <>{COUNTRY_REGIONS.map(region=><optgroup key={region} label={region}>
  {CITIES.filter(city=>city.region===region).map(city=><option key={city.name} value={city.name}>{city.name}</option>)}
 </optgroup>)}</>;
}

type Job={id:string;name:string;done:number;total:number};

export default function ProfilePage({open,onClose,saved,placeById,onOpenPlace,onRoute,onToggleSaved,onShowFavourites,onPickHome,viewCity,mapCentre,onAbout,live}:Props){
 const snap=useProfile(open),online=useOnline();
 const [supported]=useState(offlineSupported);
 const [status,setStatus]=useState<OfflineStatus|null>(null);
 const [build,setBuild]=useState<{version:string|null;dataDate:string|null}|null>(null);
 const [choice,setChoice]=useState<string|null>(null);
 const [plan,setPlan]=useState<{id:string;files:number;bytes:number|null}|null>(null);
 const [graphPlan,setGraphPlan]=useState<{files:number;bytes:number|null}|null>(null);
 const [job,setJob]=useState<Job|null>(null);
 const [offlineNote,setOfflineNote]=useState('');
 const [appNote,setAppNote]=useState('');
 const [standalone,setStandalone]=useState(isStandalone);
 const abort=useRef<AbortController|null>(null),installEvent=useRef<InstallPrompt|null>(null);

 // Chrome offers installing only through this event; keep it for the «Установить» row.
 useEffect(()=>{
  const capture=(event:Event)=>{event.preventDefault();installEvent.current=event as InstallPrompt};
  const installed=()=>{installEvent.current=null;setStandalone(true)};
  window.addEventListener('beforeinstallprompt',capture);window.addEventListener('appinstalled',installed);
  return()=>{window.removeEventListener('beforeinstallprompt',capture);window.removeEventListener('appinstalled',installed)};
 },[]);

 const refreshStatus=()=>{offlineStatus().then(setStatus).catch(()=>{})};
 useEffect(()=>{
  if(!open)return;
  setAppNote('');
  refreshStatus();
  if(!build)buildInfo().then(setBuild).catch(()=>{});
  if(supported&&!graphPlan)planGraph().then(p=>setGraphPlan({files:p.urls.length,bytes:p.bytes})).catch(()=>{});
 },[open]);

 const homeCity=snap.prefs.homeCity;
 const areaKey=choice??(homeCity||(viewCity!=='Таджикистан'&&cityByName(viewCity)?viewCity:'Шайдон'));
 function areaFor(key:string):OfflineArea|null{
  if(key==='view'){
   const [lon,lat]=mapCentre,town=cityAt(lat,lon)?.name;
   return {...viewArea(lon,lat),id:`view:${lat.toFixed(3)},${lon.toFixed(3)}`,name:town?`${town} · видимая часть`:`Участок ${lat.toFixed(3)}, ${lon.toFixed(3)}`};
  }
  const city=cityByName(key);
  return city&&city.r!==null?cityArea(city):null;
 }
 useEffect(()=>{
  if(!open||!supported)return;
  const area=areaFor(areaKey);
  if(!area){setPlan(null);return}
  let current=true;
  planArea(area).then(p=>{if(current)setPlan({id:area.id,files:p.urls.length,bytes:p.bytes})}).catch(()=>{if(current)setPlan(null)});
  return()=>{current=false};
 },[open,supported,areaKey,mapCentre[0],mapCentre[1]]);

 async function save(area:{id:string;name:string},urls:string[],bytes:number|null,remember:SavedArea|null){
  if(job)return;
  if(bytes!==null&&bytes>ASK_ABOVE&&!window.confirm(`Загрузить ≈ ${formatBytes(bytes)}? Лучше делать это по Wi‑Fi.`))return;
  const controller=new AbortController();abort.current=controller;
  setOfflineNote('');setJob({id:area.id,name:area.name,done:0,total:urls.length});
  try{
   const result=await saveUrls(urls,(done,total)=>setJob(current=>current&&current.id===area.id?{...current,done,total}:current),controller.signal);
   if(result.aborted)setOfflineNote('Сохранение остановлено. Уже загруженные файлы останутся на устройстве.');
   else if(result.failed.length)setOfflineNote(`Часть файлов не сохранилась (${result.failed.length}). Проверьте интернет и повторите.`);
   else setOfflineNote(`Готово: «${area.name}» сохранён на устройстве.`);
   if(remember&&!result.aborted&&result.failed.length<urls.length)rememberArea({...remember,at:Date.now()});
  }catch{setOfflineNote('Не удалось сохранить. Проверьте интернет и повторите.')}
  finally{abort.current=null;setJob(null);refreshStatus()}
 }
 async function saveArea(area:OfflineArea){
  if(job)return;
  setOfflineNote('Готовим список файлов…');
  try{
   const p=await planArea(area);
   if(!p.urls.length){setOfflineNote('Для этого места нет данных карты.');return}
   await save(area,p.urls,p.bytes,{id:area.id,name:area.name,files:p.urls.length,bytes:p.bytes,at:Date.now(),lat:area.lat,lon:area.lon,r:area.r});
  }catch{setOfflineNote('Не удалось подготовить участок. Проверьте интернет и повторите.')}
 }
 async function saveGraph(){
  if(job)return;
  try{const p=await planGraph();await save({id:'graph',name:'Маршруты без интернета'},p.urls,p.bytes,null)}
  catch{setOfflineNote('Не удалось загрузить дорожную сеть. Проверьте интернет и повторите.')}
 }
 function areaOf(saved:SavedArea):OfflineArea|null{
  if(Number.isFinite(saved.lat)&&Number.isFinite(saved.lon)&&Number.isFinite(saved.r))return {id:saved.id,name:saved.name,lat:saved.lat!,lon:saved.lon!,r:saved.r!};
  return saved.id.startsWith('city:')?areaFor(saved.id.slice(5)):null;
 }
 async function clearMaps(){
  if(job||!window.confirm('Удалить сохранённые участки карты? Приложение продолжит работать, участки загрузятся снова при наличии интернета.'))return;
  try{const removed=await clearSavedMaps();forgetAreas();setOfflineNote(`Удалено файлов: ${removed}`)}
  catch{setOfflineNote('Не удалось удалить сохранённые участки.')}
  refreshStatus();
 }

 async function install(){
  const prompt=installEvent.current;
  if(prompt){
   installEvent.current=null;
   try{await prompt.prompt();const outcome=await prompt.userChoice;if(outcome?.outcome==='accepted')setStandalone(true)}catch{}
   return;
  }
  setAppNote(/iPhone|iPad|iPod/.test(navigator.userAgent)?'В Safari нажмите «Поделиться», затем «На экран „Домой“».':'В меню браузера выберите «Установить приложение» или «Добавить на главный экран».');
 }
 async function share(){
  const url=location.origin+SITE_ROOT;
  try{if(navigator.share){await navigator.share({title:APP_NAME,text:`Карта Таджикистана — ${APP_NAME} ${APP_BYLINE}`,url});return}}
  catch(error){if((error as Error)?.name==='AbortError')return}
  try{await navigator.clipboard.writeText(url);setAppNote('Ссылка скопирована')}catch{setAppNote(`Ссылка: ${url}`)}
 }

 /** A stored place with the map's current name for it (a renamed street, an edited business). It keeps
     the point the reader chose: «Дом» picked by a tap on a street is that spot, not the street's middle.
     A business moves with the administrator's edits, as the page's own refresh does. */
 const fresh=(p:SearchPlace):SearchPlace=>{const now=placeById(p.id);if(!now)return p;return p.id.startsWith('business:')?now:{...p,tags:now.tags}};
 const favourites=saved.slice().reverse().map(id=>placeById(id)).filter((p):p is SearchPlace=>!!p).slice(0,5);
 const recent=snap.places.slice(0,5),routes=snap.routes.slice(0,3);
 const pct=job&&job.total?Math.round(job.done/job.total*100):0;
 const busy=!!job;

 function slotRow(slot:HomeSlot,Icon:LucideIcon,title:string,p:StoredPlace|null){
  if(!p)return <div className="profile-item">
   <button type="button" className="profile-item-main" onClick={()=>onPickHome(slot)}><Icon size={20} aria-hidden="true"/><Text title={title} hint="Не указан"/></button>
   <button type="button" className="profile-action" onClick={()=>onPickHome(slot)} aria-label={`Указать адрес «${title}»`}>Указать</button>
  </div>;
  const where=placeAddress(p);
  return <div className="profile-item">
   <button type="button" className="profile-item-main" onClick={()=>onOpenPlace(fresh(p))}><Icon size={20} aria-hidden="true"/><Text title={title} hint={where?`${placeTitle(p)} · ${where}`:placeTitle(p)}/></button>
   <button type="button" className="profile-action" onClick={()=>onRoute(fresh(p))} aria-label={`Маршрут: ${title}`}>Маршрут</button>
   <button type="button" className="profile-icon-btn" onClick={()=>setHomePlace(slot,null)} aria-label={`Удалить адрес «${title}»`}><X size={18}/></button>
  </div>;
 }

 const usage=status?.usage??null,quota=status?.quota??null;
 const areaPlan=plan&&plan.id===areaFor(areaKey)?.id?plan:null;
 const planHint=!areaPlan?'Считаем размер…':areaPlan.bytes!==null?`≈ ${formatBytes(areaPlan.bytes)} · ${areaPlan.files} ${plural(areaPlan.files,'файл','файла','файлов')}`:`${areaPlan.files} ${plural(areaPlan.files,'файл','файла','файлов')}`;

 return <Sheet open={open} onOpenChange={o=>{if(!o)onClose()}}>
  <SheetContent className="detail profile-sheet">
   <SheetHeader className="sr-only"><SheetTitle className="sr-only">Профиль</SheetTitle><SheetDescription className="sr-only">{APP_NAME} {APP_BYLINE}</SheetDescription></SheetHeader>
   <div className="profile-top" aria-hidden="true">Профиль</div>

   <div className="profile-hero">
    <CaviMark size={48}/>
    <div><strong>{APP_NAME}</strong><small>{APP_BYLINE}</small></div>
    <span className={'profile-pill'+(online?'':' is-offline')} role="status">{online?'● Онлайн':'○ Без интернета'}</span>
   </div>
   <p className="profile-note">Вход не нужен: избранное, история и настройки хранятся только на этом устройстве.</p>
   <div className="profile-stats">
    <div className="profile-stat"><b>{saved.length.toLocaleString('ru-RU')}</b><span>в избранном</span></div>
    <div className="profile-stat"><b>{(snap.places.length+snap.routes.length).toLocaleString('ru-RU')}</b><span>недавних</span></div>
    <div className="profile-stat"><b>{usage!==null?formatBytes(usage):'—'}</b><span>на устройстве</span></div>
   </div>

   <Section title="Мои места">
    {slotRow('home',House,'Дом',snap.home)}
    {slotRow('work',Briefcase,'Работа',snap.work)}
    <div className="profile-item">
     <button type="button" className="profile-item-main" onClick={onShowFavourites}><Bookmark size={20} aria-hidden="true"/><Text title="Избранное" hint={`${saved.length} ${plural(saved.length,'место','места','мест')}`}/></button>
     {saved.length>0&&<button type="button" className="profile-action" onClick={onShowFavourites}>На карте</button>}
    </div>
    {favourites.map(p=><div className="profile-item profile-sub" key={p.id}>
     <button type="button" className="profile-item-main" onClick={()=>onOpenPlace(p)}><MapPin size={18} aria-hidden="true"/><Text title={placeTitle(p)} hint={[placeKind(p),placeTown(p)].filter(Boolean).join(' · ')}/></button>
     <button type="button" className="profile-icon-btn" onClick={()=>onToggleSaved(p)} aria-label={`Убрать «${placeTitle(p)}» из избранного`}><X size={18}/></button>
    </div>)}
    {!saved.length&&<p className="profile-empty">Сохраняйте места кнопкой «В избранное» в карточке места.</p>}
   </Section>

   <Section title="Недавнее">
    {recent.map(p=><button type="button" className="profile-item" key={'p'+p.id} onClick={()=>onOpenPlace(fresh(p))}>
     <Clock size={20} aria-hidden="true"/><Text title={placeTitle(p)} hint={[placeKind(p),placeTown(p)].filter(Boolean).join(' · ')}/>
    </button>)}
    {routes.map(r=><button type="button" className="profile-item" key={'r'+r.to.id+r.mode} onClick={()=>onRoute(fresh(r.to))}>
     <Route size={20} aria-hidden="true"/><Text title={`До «${placeTitle(r.to)}»`} hint={`${MODE_LABELS[r.mode]} · ${durationLabel(r.seconds)} · ${distanceLabel(r.meters)}`}/>
    </button>)}
    {!recent.length&&!routes.length?<p className="profile-empty">Здесь появятся места и маршруты, которые вы открывали.</p>
     :<button type="button" className="profile-item profile-quiet" onClick={()=>{if(window.confirm('Очистить историю мест и маршрутов?'))clearHistory()}}><Trash2 size={18} aria-hidden="true"/><Text title="Очистить историю"/></button>}
   </Section>

   <Section title="Карта без интернета">
    {!supported?<p className="profile-hint">Сохранять карту можно, когда сайт открыт по защищённому адресу https:// — например, capline-tj-map.web.app.</p>:<>
     <p className="profile-hint">Сохранённые участки открываются без связи. Карта вдоль построенного маршрута сохраняется автоматически.</p>
     <div className="profile-item">
      <HardDrive size={20} aria-hidden="true"/>
      <Text title={`На устройстве: ${usage!==null?formatBytes(usage):'—'}`} hint={`Файлов карты: ${status?.mapFiles??0}${usage!==null&&quota!==null?` · свободно ≈ ${formatBytes(Math.max(0,quota-usage))}`:''}`}/>
     </div>
     <div className="profile-item profile-area">
      <Download size={20} aria-hidden="true"/>
      <Text title="Сохранить участок" hint={planHint}/>
      <select className="profile-select" aria-label="Участок карты" value={areaKey} disabled={busy} onChange={e=>setChoice(e.target.value)}>
       <option value="view">Видимая часть карты</option>
       <CityOptions/>
      </select>
     </div>
     {job?<>
      <div className="profile-progress" role="progressbar" aria-label={`Сохраняем «${job.name}»`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{width:pct+'%'}}/></div>
      <div className="profile-job">
       <p className="profile-hint" aria-live="polite">{job.total?`Сохраняем «${job.name}»: ${job.done} из ${job.total}…`:`Готовим «${job.name}»…`}</p>
       <button type="button" className="profile-action" onClick={()=>abort.current?.abort()}>Остановить</button>
      </div>
     </>:<div className="profile-job">
      <p className="profile-hint" aria-live="polite">{!online?'Сейчас нет интернета: новые участки сохранить не получится.':offlineNote}</p>
      <button type="button" className="profile-action" disabled={!online||!areaFor(areaKey)} onClick={()=>{const area=areaFor(areaKey);if(area)void saveArea(area)}}>Сохранить</button>
     </div>}
     <div className="profile-item">
      <Route size={20} aria-hidden="true"/>
      <Text title="Маршруты без интернета" hint={`Дорожная сеть всей страны${graphPlan?.bytes!=null?` · ≈ ${formatBytes(graphPlan.bytes)}`:''}`}/>
      {status?.graphSaved?<span className="profile-action is-done">Сохранено</span>
       :<button type="button" className="profile-action" disabled={busy||!online} onClick={()=>void saveGraph()}>Сохранить</button>}
     </div>
     {snap.areas.map(a=>{const area=areaOf(a);return <div className="profile-item" key={a.id}>
      <MapPinned size={20} aria-hidden="true"/>
      <Text title={a.name} hint={`${a.bytes!==null?formatBytes(a.bytes):`${a.files} ${plural(a.files,'файл','файла','файлов')}`} · ${new Date(a.at).toLocaleDateString('ru-RU')}`}/>
      {area&&<button type="button" className="profile-action" disabled={busy||!online} onClick={()=>void saveArea(area)} aria-label={`Обновить «${a.name}»`}>Обновить</button>}
     </div>})}
     {(status?.mapFiles||snap.areas.length)?<button type="button" className="profile-item profile-danger" disabled={busy} onClick={()=>void clearMaps()}><Trash2 size={20} aria-hidden="true"/><Text title="Удалить сохранённые карты"/></button>:null}
    </>}
   </Section>

   <Section title="Настройки">
    <label className="profile-item">
     <MapPinned size={20} aria-hidden="true"/>
     <Text title="Мой город" hint="Для поиска и сохранения карты"/>
     <select className="profile-select" value={homeCity??''} onChange={e=>{const value=e.target.value||null;writePrefs(value?{homeCity:value}:{homeCity:null,openInHomeCity:false})}}>
      <option value="">— не выбран —</option>
      <CityOptions/>
     </select>
    </label>
    <SwitchRow Icon={MapPin} title="Открывать карту в моём городе" hint={homeCity?'Иначе карта открывается там, где вы её оставили':'Сначала выберите свой город'} on={!!homeCity&&snap.prefs.openInHomeCity} disabled={!homeCity} onToggle={on=>writePrefs({openInHomeCity:on})}/>
    <SwitchRow Icon={Rotate3d} title="Объёмный вид при запуске" hint="Дома в 3D сразу после открытия карты" on={snap.prefs.start3d} onToggle={on=>writePrefs({start3d:on})}/>
    <SwitchRow Icon={Building2} title="Подробные здания" hint="Окна, крыши и деревья вблизи. Отключите на слабом телефоне" on={snap.detail} onToggle={writeBuildingDetail}/>
    <SwitchRow Icon={Volume2} title="Голосовые подсказки" hint="Навигатор проговаривает повороты" on={snap.voice} onToggle={writeVoice}/>
    <p className="profile-label" id="profile-mode-label">Способ передвижения по умолчанию</p>
    <div className="profile-modes" role="group" aria-labelledby="profile-mode-label">
     {MODES.map(m=>{const Icon=MODE_ICONS[m];return <button type="button" key={m} aria-pressed={snap.mode===m} onClick={()=>writeMode(m)}><Icon size={17} aria-hidden="true"/>{MODE_LABELS[m]}</button>})}
    </div>
   </Section>

   <Section title="Приложение">
    {!standalone&&<button type="button" className="profile-item" onClick={()=>void install()}><Smartphone size={20} aria-hidden="true"/><Text title="Установить на телефон" hint={`${APP_NAME} на главном экране, как обычное приложение`}/></button>}
    <button type="button" className="profile-item" onClick={()=>void share()}><Share2 size={20} aria-hidden="true"/><Text title="Поделиться картой" hint={`Отправить ссылку на ${APP_NAME}`}/></button>
    {appNote&&<p className="profile-hint" role="status">{appNote}</p>}
    <a className="profile-item" href={siteUrl('/gps-help.html')} target="_blank" rel="noreferrer"><LocateFixed size={20} aria-hidden="true"/><Text title="Как включить GPS" hint="Если навигатор не видит местоположение"/></a>
    <button type="button" className="profile-item" onClick={onAbout}><Info size={20} aria-hidden="true"/><Text title="О карте и данных" hint="Источники, лицензии, точность"/></button>
    <a className="profile-item" href={siteUrl('/street-sources.html')} target="_blank" rel="noreferrer"><Signpost size={20} aria-hidden="true"/><Text title="Названия улиц Шайдона" hint="Источники и проектные названия"/></a>
   </Section>

   <Section title="Для администратора">
    <a className="profile-item" href={siteUrl('/admin')}><ShieldCheck size={20} aria-hidden="true"/><Text title="Панель администратора" hint="Управление картой (нужен вход)"/></a>
   </Section>

   <p className="profile-footer">
    {APP_NAME} {APP_BYLINE}
    <br/>Версия {APP_VERSION}{build?.version?` · сборка ${build.version}`:''}
    <br/>© участники OpenStreetMap, ODbL{build?.dataDate?` · срез данных ${dayLabel(build.dataDate)}`:''}
    <br/><span title={live.error||undefined}>{liveLabel(live)}</span>
   </p>
  </SheetContent>
 </Sheet>;
}

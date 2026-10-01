import {useEffect,useState} from 'react';
import {getApps} from 'firebase/app';
import {getAuth} from 'firebase/auth';
import {getRuntimeConfig} from '../lib/live-store';
type Key={id:string;name:string;origins:string[];rpm:number;revoked:boolean};
export function PartnerApiPanel(){
 const [keys,setKeys]=useState<Key[]>([]),[name,setName]=useState(''),[origins,setOrigins]=useState(''),[rpm,setRpm]=useState(60),[secret,setSecret]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function request(method='GET',input?:unknown){
  const config=await getRuntimeConfig() as {apiBaseUrl?:string};const base=config.apiBaseUrl||location.origin;
  const app=getApps().find(a=>a.name==='atlas-live'),token=app?await getAuth(app).currentUser?.getIdToken():undefined;
  const res=await fetch(new URL('/api/partner/keys',base),{method,credentials:base===location.origin?'same-origin':'omit',headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
  const data=await res.json().catch(()=>{throw Error('API-сервер не подключён. Укажите apiBaseUrl в runtime-config.json после размещения backend.')});if(!res.ok)throw Error(data.error||`Ошибка ${res.status}`);return data;
 }
 async function refresh(){try{setKeys((await request()).keys);setError('')}catch(e){setError((e as Error).message)}}
 useEffect(()=>{void refresh()},[]);
 return <section className="admin-form"><h2>API для других сайтов</h2><p>Сайт такси отправляет точки А и Б на API и получает GeoJSON маршрута. Секрет храните на сервере сайта такси.</p><form onSubmit={async event=>{event.preventDefault();setBusy(true);setSecret('');try{const data=await request('POST',{name,origins:origins.split(/[\s,]+/).filter(Boolean),rpm});setSecret(data.secret);await refresh()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>
 <label>Название сайта<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
 <label>Разрешённые origin<input placeholder="https://taxi.example" value={origins} onChange={e=>setOrigins(e.target.value)}/></label><p>Без доменов — доступ только с сервера. Проверка origin ограничивает браузерные запросы; она не заменяет секретный ключ.</p>
 <label>Запросов в минуту<input type="number" min={1} max={600} value={rpm} onChange={e=>setRpm(Number(e.target.value))}/></label><button className="admin-button primary" disabled={busy}>Создать ключ</button></form>
 {error&&<p role="alert">{error}</p>}{secret&&<label>Сохраните секрет: он показывается один раз<input readOnly value={secret}/></label>}
 {keys.map(key=><div key={key.id}><strong>{key.name}</strong><p>{key.origins.join(', ')||'Серверный доступ'} · {key.rpm}/мин · {key.revoked?'Отозван':'Активен'}</p>{!key.revoked&&<button className="admin-button" disabled={busy} onClick={async()=>{setBusy(true);try{await request('DELETE',{id:key.id});await refresh()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>Отозвать ключ</button>}</div>)}
 </section>
}

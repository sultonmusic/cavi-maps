import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {createRoutingPool} from './routing-pool.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const error=(message,status=400)=>Object.assign(new Error(message),{status});
export function createPartnerApi({root,authenticated,body,send}) {
 const file=path.join(root,'data','api-keys.json'),pool=createRoutingPool(root),limits=new Map();let keys=[],queue=Promise.resolve();
 const loaded=readFile(file,'utf8').then(raw=>{keys=JSON.parse(raw)}).catch(e=>{if(e.code!=='ENOENT')throw e});
 const publicKey=({digest,...key})=>key;
 function save(change){const task=queue.then(async()=>{const next=structuredClone(keys),value=change(next);await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomBytes(6).toString('hex');await writeFile(temp,JSON.stringify(next),{mode:0o600});await rename(temp,file);keys=next;return value});queue=task.catch(()=>{});return task}
 function limit(id,max){const now=Date.now();for(const [k,v] of limits)if(v.until<now)limits.delete(k);const entry=limits.get(id);if(!entry)limits.set(id,{count:1,until:now+60000});else if(++entry.count>max)throw error('Лимит запросов исчерпан',429)}
 async function admin(req){if(authenticated(req))return true;const uid=process.env.ATLAS_ADMIN_UID,projectId=process.env.ATLAS_FIREBASE_PROJECT_ID,token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!uid||!projectId||!token)return false;
  try{const {initializeApp,getApps}=await import('firebase-admin/app');const {getAuth}=await import('firebase-admin/auth');const app=getApps().find(a=>a.name==='partner-api')||initializeApp({projectId},'partner-api');const claims=await getAuth(app).verifyIdToken(token);return claims.uid===uid}catch{return false}
 }
 async function handle(req,res){const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/api/v1/')&&!url.pathname.startsWith('/api/partner/'))return false;
 try{await loaded;
  if(url.pathname==='/api/partner/keys'){
   if(req.method==='OPTIONS'&&req.headers.origin===process.env.ATLAS_ADMIN_ORIGIN){res.writeHead(204,{'Access-Control-Allow-Origin':req.headers.origin,'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Vary':'Origin'});res.end();return true}
   if(!await admin(req))throw error('Войдите как администратор API',401);
   // Cookies require same-origin; Firebase bearer tokens may use the explicitly allowed console origin.
   const origin=req.headers.origin,consoleOrigin=process.env.ATLAS_ADMIN_ORIGIN;
   if(origin&&new URL(origin).host!==req.headers.host&&origin!==consoleOrigin)throw error('Источник запрещён',403);
   if(origin&&origin===consoleOrigin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin')}
   if(req.method==='GET'){send(res,200,{keys:keys.map(publicKey)});return true}
   const input=await body(req);
   if(req.method==='POST'){
    if(keys.filter(k=>!k.revoked).length>=200)throw error('Сначала удалите неиспользуемые ключи');
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100)throw error('Укажите название');
    if(!Array.isArray(input.origins)||input.origins.length>20)throw error('Укажите разрешённые домены');
    const origins=[...new Set(input.origins.map(value=>{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.origin!==value)throw error('Укажите origin, например https://taxi.example');return value}))];
    const rpm=input.rpm??60;if(!Number.isInteger(rpm)||rpm<1||rpm>600)throw error('Лимит: от 1 до 600 в минуту');
    const secret='cavi_'+randomBytes(32).toString('hex'),key={id:randomBytes(12).toString('hex'),name:input.name.trim(),origins,rpm,createdAt:Date.now(),revoked:false,digest:hash(secret)};
    await save(next=>next.push(key));send(res,201,{key:publicKey(key),secret});return true;
   }
   if(req.method==='DELETE'){const found=keys.find(k=>k.id===input.id);if(!found)throw error('Ключ не найден',404);await save(next=>{next.find(k=>k.id===input.id).revoked=true});send(res,200,{ok:true});return true}
   throw error('Метод не разрешён',405);
  }
  if(url.pathname!=='/api/v1/routes')throw error('Метод API не найден',404);
  if(req.method==='OPTIONS'){
   const origin=req.headers.origin;if(!origin||!keys.some(k=>!k.revoked&&k.origins.includes(origin)))throw error('Домен не разрешён',403);
   res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600','Vary':'Origin'});res.end();return true;
  }
  const token=req.headers.authorization?.match(/^Bearer (cavi_[a-f0-9]{64})$/)?.[1];if(!token)throw error('Требуется API-ключ',401);
  const digest=Buffer.from(hash(token),'hex'),key=keys.find(k=>!k.revoked&&timingSafeEqual(digest,Buffer.from(k.digest,'hex')));if(!key)throw error('API-ключ недействителен',401);
  const origin=req.headers.origin;if(origin&&!key.origins.includes(origin))throw error('Домен не разрешён',403);if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin')}
  if(req.method!=='POST')throw error('Используйте POST',405);limit(key.id,key.rpm);
  const input=await body(req),point=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=35.5&&p[0]<=42&&p[1]>=66&&p[1]<=76.5;
  if(!point(input.start)||!point(input.end))throw error('Координаты: [широта, долгота] в Таджикистане');
  const mode=input.mode??'car';if(!['car','bike','foot'].includes(mode))throw error('Режим: car, bike, foot');
  const result=await pool.request({start:input.start,end:input.end,network:mode,maxRoutes:1,speed:mode==='car'?35:mode==='bike'?15:5});if(result.error)throw error(result.error,422);
  send(res,200,{mode,traffic:false,coordinatesOrder:'longitude,latitude',routes:result.routes.map(route=>({distanceMeters:route.meters,durationSeconds:route.seconds,geometry:{type:'LineString',coordinates:route.path.map(([lat,lon])=>[lon,lat])}})),startGap:result.startGap,endGap:result.endGap});
 }catch(e){if(e.status===429||e.status===503)res.setHeader('Retry-After','60');send(res,e.status??400,{error:e.message||'Ошибка API'})}return true;
 }
 handle.close=()=>pool.close();return handle;
}

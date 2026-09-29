/* The service worker (public/sw.js) in a fake worker scope: core install, old-cache cleanup,
 * the same-origin guard, cache-first map data, offline fallbacks and the CACHE_URLS message.
 * Runs twice, for the Firebase root (/) and the GitHub Pages root (/cavi-maps/).
 *
 *   node scripts/check-offline.mjs
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
const cacheName=/const CACHE_NAME = '([^']+)'/.exec(source)?.[1];
assert.ok(cacheName?.startsWith('atlas-'),'CACHE_NAME keeps the atlas- prefix that activate() cleans up by');
const origin='https://localhost:4174';

async function scenario(root){
 const at=path=>root+path.replace(/^\//,'');
 const handlers=new Map(),stores=new Map();
 let online=true,fetches=0,claimed=false,skipped=false;const fetched=[];
 const key=request=>new URL(typeof request==='string'?request:request.href||request.url,origin).href;
 const caches={
  async open(name){if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);return{
   match:async request=>store.get(key(request))?.clone(),
   put:async(request,response)=>{store.set(key(request),response.clone())},
  }},
  async keys(){return [...stores.keys()]},async delete(name){return stores.delete(name)},
 };
 const self={location:{origin,href:origin+root+'sw.js'},addEventListener:(name,handler)=>handlers.set(name,handler),
  clients:{claim:async()=>{claimed=true}},skipWaiting:async()=>{skipped=true}};
 async function fetch(request){fetches++;fetched.push(key(request));if(!online)throw Error('offline');const url=new URL(key(request));
  if(url.pathname===at('/offline-manifest.json'))return Response.json({urls:['/','/index.html','/assets/app.js','/manifest.webmanifest','/icon-192.png']});
  if(/\/(missing\.json|private)$/.test(url.pathname))return new Response('no',{status:404});
  return new Response(url.pathname,{status:200});
 }
 vm.runInNewContext(source,{self,caches,fetch,URL,Response,AbortController,setTimeout,clearTimeout,Map,Set});
 async function lifecycle(name){let work;handlers.get(name)({waitUntil:p=>{work=p}});await work}
 async function request(path,mode='cors'){
  let result;const work=[];
  handlers.get('fetch')({request:{method:'GET',url:origin+at(path),mode},respondWith:p=>{result=p},waitUntil:p=>work.push(p)});
  const response=await result;await Promise.all(work);return response;
 }
 async function cacheUrls(urls){let work,answer;handlers.get('message')({data:{type:'CACHE_URLS',urls},ports:[{postMessage:r=>{answer=r}}],waitUntil:p=>{work=p}});await work;return answer}
 const cached=path=>stores.get(cacheName)?.has(origin+at(path));

 await lifecycle('install');assert.equal(skipped,true);
 for(const path of ['/','/index.html','/assets/app.js','/manifest.webmanifest','/icon-192.png'])assert.ok(cached(path),`core file ${path} is saved under ${root}`);
 await caches.open('atlas-old');await caches.open('other-app');await lifecycle('activate');assert.equal(claimed,true);
 assert.deepEqual(await caches.keys(),[cacheName,'other-app'],'only older atlas- caches are removed');

 assert.equal((await cacheUrls(['/atlas-data/bundle-13-1-1.json','/graph-nodes-0.json','/road-routes.json'])).ok,true);
 assert.ok(cached('/road-routes.json'),'site paths are saved under the site root');
 let before=fetches;
 assert.equal(await(await request('/graph-nodes-0.json')).text(),at('/graph-nodes-0.json'));
 assert.equal(await(await request('/road-routes.json')).text(),at('/road-routes.json'));
 assert.equal(fetches,before,'saved graph and road routes are answered from the cache first');
 await request('/road-routes-extra.json');before=fetches;await request('/road-routes-extra.json');
 assert.equal(fetches,before,'the admin road strokes are map data too');
 assert.equal(await request('/runtime-config.json'),undefined,'runtime config goes straight to the network, never the cache');
 const invalid=await cacheUrls(['https://outside.example/private']);assert.equal(invalid.ok,false);
 assert.ok(fetched.every(url=>url.startsWith(origin+'/')),'nothing is fetched from another origin');

 online=false;
 assert.equal(await(await request('/atlas-data/bundle-13-1-1.json')).text(),at('/atlas-data/bundle-13-1-1.json'));
 assert.equal(await(await request('/assets/app.js')).text(),at('/assets/app.js'));
 assert.equal(await(await request('/manifest.webmanifest')).text(),at('/manifest.webmanifest'),'the install manifest works offline');
 assert.equal(await(await request('/new-local-page','navigate')).text(),at('/index.html'));
 const missing=await request('/atlas-data/missing.json');assert.equal(missing.status,503);
 assert.match(await missing.text(),/^Нет связи с Cavi Maps\./);
 assert.equal((await cacheUrls(['/atlas-data/missing.json'])).ok,false);
 online=true;assert.equal((await cacheUrls(['/atlas-data/missing.json'])).ok,false,'an HTTP error is reported, not cached');
}

await scenario('/');
await scenario('/cavi-maps/');
console.log(`Offline checks passed under / and /cavi-maps/ (${cacheName}): core install with the app manifest and icons, cache cleanup, same-origin guard, cache-first graph and road routes, offline map/assets/navigation, uncached failure and message acknowledgement.`);

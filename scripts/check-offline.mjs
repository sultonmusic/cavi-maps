import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const origin='https://localhost:4174';
const handlers=new Map(),stores=new Map();
let online=true,fetches=0,claimed=false,skipped=false;
const key=request=>new URL(typeof request==='string'?request:request.href||request.url,origin).href;
const caches={
 async open(name){if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);return{
  match:async request=>store.get(key(request))?.clone(),
  put:async(request,response)=>{store.set(key(request),response.clone())},
 }},
 async keys(){return [...stores.keys()]},async delete(name){return stores.delete(name)},
};
const self={location:{origin},addEventListener:(name,handler)=>handlers.set(name,handler),
 clients:{claim:async()=>{claimed=true}},skipWaiting:async()=>{skipped=true}};
async function fetch(request){fetches++;if(!online)throw Error('offline');const url=new URL(key(request));
 if(url.pathname==='/offline-manifest.json')return Response.json({urls:['/','/index.html','/assets/app.js']});
 return new Response(url.pathname,{status:200});
}
vm.runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,caches,fetch,URL,Response,AbortController,setTimeout,clearTimeout,Map,Set});
async function lifecycle(name){let work;handlers.get(name)({waitUntil:p=>{work=p}});await work}
async function request(path,mode='cors'){
 let result;const work=[];
 handlers.get('fetch')({request:{method:'GET',url:origin+path,mode},respondWith:p=>{result=p},waitUntil:p=>work.push(p)});
 const response=await result;await Promise.all(work);return response;
}
async function cacheUrls(urls){let work,answer;handlers.get('message')({data:{type:'CACHE_URLS',urls},ports:[{postMessage:r=>{answer=r}}],waitUntil:p=>{work=p}});await work;return answer}
await lifecycle('install');assert.equal(skipped,true);
await caches.open('atlas-old');await lifecycle('activate');assert.equal(claimed,true);assert.deepEqual(await caches.keys(),['atlas-20260908-admin1']);
assert.equal((await cacheUrls(['/atlas-data/bundle-13-1-1.json','/graph-nodes-0.json'])).ok,true);
const before=fetches;assert.equal(await(await request('/graph-nodes-0.json')).text(),'/graph-nodes-0.json');assert.equal(fetches,before,'Dated graph uses cached response first');
const invalid=await cacheUrls(['https://outside.example/private']);assert.equal(invalid.ok,false);assert.equal(fetches,before,'External URLs are not fetched');
online=false;
assert.equal(await(await request('/atlas-data/bundle-13-1-1.json')).text(),'/atlas-data/bundle-13-1-1.json');
assert.equal(await(await request('/assets/app.js')).text(),'/assets/app.js');
assert.equal(await(await request('/new-local-page','navigate')).text(),'/index.html');
assert.equal((await request('/atlas-data/missing.json')).status,503);
assert.equal((await cacheUrls(['/atlas-data/missing.json'])).ok,false);
console.log('Offline checks passed: core install, cache cleanup, same-origin guard, cache-first graph, offline map/assets/navigation, uncached failure and message acknowledgement.');

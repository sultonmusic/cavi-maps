import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,copyFile,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPartnerApi} from '../server/partner-api.mjs';
test('keys, origin controls, GeoJSON, limits and revocation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'cavi-api-'));await mkdir(path.join(root,'public'));
 for(const name of ['route-worker.js','route-rules.js'])await copyFile('public/'+name,path.join(root,'public',name));
 await writeFile(path.join(root,'public','road-graph.json'),JSON.stringify({nodes:[[38.57,68.78],[38.57,68.79],[38.58,68.79]],edges:[[0,1,0],[1,2,0]],modes:1}));
 const api=createPartnerApi({root,authenticated:req=>req.headers.cookie==='admin=yes',body:async req=>{let raw='';for await(const c of req)raw+=c;return JSON.parse(raw)},send:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))}});
 const server=http.createServer(async(req,res)=>{if(!await api(req,res)){res.writeHead(404);res.end()}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(url,method='GET',input,headers={}){const res=await fetch(base+url,{method,headers:{...(input?{'Content-Type':'application/json'}:{}),...headers},...(input?{body:JSON.stringify(input)}:{})});return {status:res.status,data:res.status===204?null:await res.json(),headers:res.headers}}
 try{
 assert.equal((await request('/api/partner/keys')).status,401);
 const created=await request('/api/partner/keys','POST',{name:'Taxi',origins:['https://taxi.example'],rpm:2},{cookie:'admin=yes'});assert.equal(created.status,201);const {secret,key}=created.data;
 assert(!JSON.stringify((await request('/api/partner/keys','GET',null,{cookie:'admin=yes'})).data).includes(secret));assert(!(await readFile(path.join(root,'data','api-keys.json'),'utf8')).includes(secret));
 const input={start:[38.57,68.78],end:[38.58,68.79]},headers={Authorization:`Bearer ${secret}`};
 assert.equal((await request('/api/v1/routes','POST',input)).status,401);assert.equal((await request('/api/v1/routes','POST',input,{...headers,Origin:'https://evil.example'})).status,403);
 assert.equal((await request('/api/v1/routes','OPTIONS',null,{Origin:'https://taxi.example'})).status,204);
 const route=await request('/api/v1/routes','POST',input,{...headers,Origin:'https://taxi.example'});assert.equal(route.status,200);assert.equal(route.headers.get('access-control-allow-origin'),'https://taxi.example');assert.equal(route.data.routes[0].geometry.type,'LineString');assert.deepEqual(route.data.routes[0].geometry.coordinates[0],[68.78,38.57]);
 assert.equal((await request('/api/v1/routes','POST',{...input,start:[0,0]},headers)).status,400);assert.equal((await request('/api/v1/routes','POST',input,headers)).status,429);
 assert.equal((await request('/api/partner/keys','DELETE',{id:key.id},{cookie:'admin=yes'})).status,200);assert.equal((await request('/api/v1/routes','POST',input,headers)).status,401);
 }finally{api.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
});

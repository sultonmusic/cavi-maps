import http from 'node:http';
import https from 'node:https';
import {createReadStream,existsSync,statSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {networkInterfaces} from 'node:os';
import {spawn} from 'node:child_process';
import {createAdminApi} from './server/admin-api.mjs';

const root=fileURLToPath(new URL('./dist/',import.meta.url));
const useHttps=process.argv.includes('--https');
const protocol=useHttps?'https':'http';
const port=Number(process.env.PORT||(useHttps?4174:4173));
if(!Number.isInteger(port)||port<1||port>65535){console.error('PORT должен быть числом от 1 до 65535.');process.exit(1)}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8','.woff2':'font/woff2'};
if(!existsSync(path.join(root,'index.html'))){console.error('Нет готовой сборки dist. Выполните npm ci, затем npm run build.');process.exit(1)}
const adminApi=createAdminApi({root:fileURLToPath(new URL('.',import.meta.url))});
const handleRequest=async(req,res)=>{
 if(process.argv.includes('--local-data')&&req.url?.split('?')[0]==='/runtime-config.json'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{}');return}
 try {if(await adminApi(req,res))return} catch {res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Ошибка сервера'}));return}
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
 let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{res.writeHead(400);res.end();return}
 const file=path.resolve(root,'.'+((['/', '/admin', '/admin/'].includes(pathname)||/^\/Capline-Group\/Maps\/Tajikistan\/[^/]+\/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\/?$/.test(pathname))?'/index.html':pathname));
 const relative=path.relative(root,file);
 if(relative.startsWith('..')||path.isAbsolute(relative)||!existsSync(file)||!statSync(file).isFile()){res.writeHead(404);res.end('Not found');return}
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':statSync(file).size,'Cache-Control':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache','X-Content-Type-Options':'nosniff'});
 if(req.method==='HEAD')res.end();else{const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res)}
};
let server;
try{
 const certificateRoot=process.env.ATLAS_CERT_DIR?path.resolve(process.env.ATLAS_CERT_DIR):fileURLToPath(new URL('./security/',import.meta.url));
 server=useHttps?https.createServer({key:readFileSync(path.join(certificateRoot,'server-key.pem')),cert:readFileSync(path.join(certificateRoot,'server-cert.pem'))},handleRequest):http.createServer(handleRequest);
}catch(e){console.error('Нет действующих локальных сертификатов. Запустите HTTPS.cmd. Подробности: GPS-HTTPS.md.');process.exit(1)}
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Порт ${port} уже занят. Закройте предыдущий Cavi Maps или задайте PORT.`:e.message);process.exitCode=1});
server.listen(port,'0.0.0.0',()=>{
 console.log(`\nCavi Maps — карта Таджикистана (by Capline Group)\nНа компьютере: ${protocol}://localhost:${port}`);
 let interfaces={};try{interfaces=networkInterfaces()}catch{}
 for(const addresses of Object.values(interfaces))for(const a of addresses||[])if(a.family==='IPv4'&&!a.internal)console.log(`На телефоне в той же Wi-Fi сети: ${protocol}://${a.address}:${port}`);
 if(useHttps)console.log('\nДля GPS на телефоне сначала настройте доверие к локальному сертификату: GPS-HTTPS.md.');
 console.log('\nОставьте это окно открытым. Для остановки нажмите Ctrl+C.\n');
 if(process.argv.includes('--open')){const child=spawn('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-Command',`Start-Process '${protocol}://localhost:${port}'`],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref()}
});

for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{adminApi.close();server.close(()=>process.exit(0));server.closeAllConnections()});

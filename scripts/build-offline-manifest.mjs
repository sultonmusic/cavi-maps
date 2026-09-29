/* Runs after `vite build` (npm run build). Writes two files into dist/:
 *   offline-manifest.json  the core files public/sw.js saves on install, with the build version,
 *                          the map data date and the build date;
 *   offline-sizes.json     the size of every map file that can be saved for offline use later
 *                          (map bundles, houses, roads, things, walks and the routing graph).
 *
 *   node scripts/build-offline-manifest.mjs [dist-folder]
 *
 * Bump `version` together with CACHE_NAME in public/sw.js.
 */
import {readdir,writeFile,stat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=process.argv[2]?path.resolve(process.argv[2]):fileURLToPath(new URL('../dist/',import.meta.url));
const urls=['/','/index.html','/route-worker.js','/route-rules.js','/road-graph.json','/places.json','/atlas-data/index.json','/favicon.svg','/manifest.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-512.png','/gps-help.html','/streets.json','/districts.json','/shaydon-buildings.json','/shaydon-osm-buildings.json','/atlas-houses/index.json','/atlas-roads/index.json','/atlas-things/index.json','/atlas-walks/index.json','/street-sources.html','/atlas-data/LICENSE.txt','/atlas-data/index.json?names=3'];
// Saved on install when the build has them. road-routes.json is made by scripts/build-road-routes.py;
// until then the map loads without road numbers, so a build without it must still install offline.
const optional=['/road-routes.json'];
const fileOf=url=>path.join(root,url==='/'?'index.html':url.split('?')[0].slice(1));
const sizeOf=async file=>{try{const info=await stat(file);return info.isFile()?info.size:null}catch{return null}};
for(const url of optional){
 if(await sizeOf(fileOf(url))!==null)urls.push(url);
 else console.warn(`Offline manifest: ${url} is not in the build; it will be saved when first used.`);
}
async function assets(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const target=path.join(directory,entry.name);
    if(entry.isDirectory())await assets(target);
    else urls.push('/'+path.relative(root,target).split(path.sep).join('/'));
  }
}
await assets(path.join(root,'assets'));
let bytes=0;
for(const url of urls){const size=await sizeOf(fileOf(url));if(size===null)throw Error(`Missing core file ${url} in ${root}`);bytes+=size}
let dataDate=null;
try{dataDate=JSON.parse(await readFile(fileOf('/atlas-data/index.json'),'utf8')).date??null}catch{}
const manifest={version:'20260929-cavi1',dataDate,builtAt:new Date().toISOString().slice(0,10),bytes,urls};
await writeFile(path.join(root,'offline-manifest.json'),JSON.stringify(manifest));

// Sizes of the files a person can save for a city or for the whole routing graph (lib/offline-maps.ts).
const SAVABLE=/^(bundle-\d+-\d+-\d+\.json|\d+-\d+\.(json|bin))$/,GRAPH=/^(graph-(nodes|edges)-\d+\.json|road-graph\.json)$/;
const sized=[];
async function sizeFiles(folder,test){
 let entries;try{entries=await readdir(path.join(root,folder),{withFileTypes:true})}catch{return}
 const names=entries.filter(entry=>entry.isFile()&&test.test(entry.name)).map(entry=>entry.name);
 for(let i=0;i<names.length;i+=64)sized.push(...await Promise.all(names.slice(i,i+64).map(async name=>
  [(folder?`/${folder}/`:'/')+name,(await stat(path.join(root,folder,name))).size])));
}
for(const folder of ['atlas-data','atlas-houses','atlas-roads','atlas-things','atlas-walks'])await sizeFiles(folder,SAVABLE);
await sizeFiles('',GRAPH);
sized.sort(([a],[b])=>a<b?-1:a>b?1:0);
await writeFile(path.join(root,'offline-sizes.json'),JSON.stringify({version:manifest.version,files:Object.fromEntries(sized)}));

const html=await readFile(path.join(root,'index.html'),'utf8');
// A GitHub Pages build prefixes its root (/cavi-maps/); the manifest lists paths from the root.
for(const [,asset] of html.matchAll(/(?:src|href)="\/(?:[^"\/]+\/)?(assets\/[^"?#]+)/g)){const url='/'+asset;if(!urls.includes(url))throw Error('Missing core asset: '+url);}
const savable=sized.reduce((sum,[,size])=>sum+size,0);
console.log(`Offline manifest ${manifest.version}: ${urls.length} core files, ${(bytes/1024/1024).toFixed(1)} MB, map data of ${dataDate??'unknown date'}. ${sized.length} map and graph files (${(savable/1024/1024).toFixed(1)} MB) can be saved on demand; sizes in offline-sizes.json.`);

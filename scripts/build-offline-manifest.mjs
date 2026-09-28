import {readdir,writeFile,stat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../dist/',import.meta.url));
const urls=['/','/index.html','/route-worker.js','/road-graph.json','/places.json','/atlas-data/index.json','/favicon.svg','/gps-help.html','/streets.json','/districts.json','/shaydon-buildings.json','/shaydon-osm-buildings.json','/atlas-houses/index.json','/atlas-roads/index.json','/atlas-things/index.json','/atlas-walks/index.json','/street-sources.html','/atlas-data/index.json?names=3'];
async function assets(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const target=path.join(directory,entry.name);
    if(entry.isDirectory())await assets(target);
    else urls.push('/'+path.relative(root,target).split(path.sep).join('/'));
  }
}
await assets(path.join(root,'assets'));
let bytes=0;
for(const url of urls)bytes+=(await stat(path.join(root,url==='/'?'index.html':url.split('?')[0].slice(1)))).size;
await writeFile(path.join(root,'offline-manifest.json'),JSON.stringify({version:'20260928-pages1',bytes,urls}));
const html=await readFile(path.join(root,'index.html'),'utf8');
// A GitHub Pages build prefixes its root (/cavi-maps/); the manifest lists paths from the root.
for(const [,asset] of html.matchAll(/(?:src|href)="\/(?:[^"\/]+\/)?(assets\/[^"?#]+)/g)){const url='/'+asset;if(!urls.includes(url))throw Error('Missing core asset: '+url);}
console.log(`Offline manifest: ${urls.length} core files, ${(bytes/1024/1024).toFixed(1)} MB. Road graph and map bundles are cached on demand.`);

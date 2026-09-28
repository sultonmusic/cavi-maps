import assert from 'node:assert/strict';
const base=process.env.ATLAS_URL||'http://localhost:4173';
const response=await fetch(base),html=await response.text();
assert(response.ok);assert(html.includes('lang="ru"'));
const assets=[...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m=>m[1]);
for(const url of [...assets,'/places.json','/streets.json','/districts.json','/street-sources.html','/shaydon-buildings.json','/shaydon-osm-buildings.json','/offline-manifest.json','/sw.js','/atlas-data/index.json?names=3','/atlas-data/index.json','/road-graph.json','/route-worker.js']){
 const r=await fetch(base+url);assert(r.ok,url);
 if(url==='/shaydon-buildings.json'){const data=await r.json();assert(data.buildings.length>5000);assert(data.number.some(Boolean));assert.equal(data.licence,'ODbL');}
 else if(url==='/shaydon-osm-buildings.json'){const data=await r.json();assert.equal(data.licence,'ODbL');assert(data.buildings.some(b=>b.id==='way/1551050506'&&b.name==='Фарханг'));}
 else if(url==='/places.json')assert.equal((await r.json()).length,8002);
 else if(url==='/streets.json'){const data=await r.json();assert.equal(data.roads.length,10102);assert.equal(data.roads.find(r=>r.id==='way/1133986166').name,'Улица Маданият');assert.equal(data.localNaming.official,false);}
 else if(url==='/districts.json'){const data=await r.json();assert.equal(data.districts.length,4);assert.equal(data.official,false);}
 else if(url==='/atlas-data/index.json'){
  const index=await r.json();const [z,x,y]=index.tiles[0].replace('.json','').split('-').map(Number);
  const bundle=await fetch(`${base}/atlas-data/bundle-${z}-${Math.floor(x/4)}-${Math.floor(y/4)}.json`);assert(bundle.ok);assert((await bundle.json())[index.tiles[0]]);
 }
 console.log('PASS HTTP',url);
}
assert.equal((await fetch(base+'/missing-file.json')).status,404);
console.log('PASS: Russian page, bundled assets, local map data, 8002 places, attribution setting, missing-file response');

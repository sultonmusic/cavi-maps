import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
function shell(path='/'){
 const listeners=new Map(),element=()=>({style:{},addEventListener(){}}),frame={...element(),contentWindow:{}},status=element(),message=element(),retry=element();const url=new URL('https://capline-group-maps.web.app'+path),history=[];
 const context={URL,Number,encodeURIComponent,location:{href:url.href,pathname:url.pathname,search:url.search,origin:url.origin},document:{getElementById:id=>({map:frame,status,message,retry})[id]},window:{addEventListener:(type,fn)=>listeners.set(type,fn)},history:{replaceState:(a,b,next)=>history.push(next)},setTimeout:()=>1,clearTimeout:()=>{}};
 const code=readFileSync('hosting/firebase-shell/shell.js','utf8').replace('__MAPS_SOURCE_URL__',JSON.stringify('https://sultonmusic.github.io/cavi-maps/'));vm.runInNewContext(code,context);
 return {frame,status,history,message:event=>listeners.get('message')(event)};
}
test('Firebase URL remains in the address bar and coordinates safely reach the map',()=>{
 const s=shell('/Capline-Group/Maps/Tajikistan/Dushanbe/38.559772,68.787038?z=16');const src=new URL(s.frame.src);assert.equal(src.host,'sultonmusic.github.io');assert.equal(src.pathname,'/cavi-maps/Capline-Group/Maps/Tajikistan/Dushanbe/38.559772,68.787038');assert.equal(src.searchParams.get('parentOrigin'),'https://capline-group-maps.web.app');
 const event={source:s.frame.contentWindow,origin:'https://sultonmusic.github.io',data:{type:'cavi:view',lat:38.57,lon:68.79,zoom:16,city:'Dushanbe'}};
 s.message({...event,origin:'https://evil.example'});assert.equal(s.history.length,0);s.message({...event,source:{}});assert.equal(s.history.length,0);s.message({...event,data:{...event.data,lat:91}});assert.equal(s.history.length,0);
 s.message(event);assert.equal(s.history[0].origin,'https://capline-group-maps.web.app');assert.match(s.history[0].pathname,/38\.570000,68\.790000$/);
 s.message({...event,data:{type:'cavi:ready'}});assert.equal(s.status.style.display,'none');
});
test('query cannot replace the source or trusted parent origin',()=>{const s=shell('/?parentOrigin=https://evil.example&source=https://evil.example');const src=new URL(s.frame.src);assert.equal(src.origin,'https://sultonmusic.github.io');assert.equal(src.searchParams.get('parentOrigin'),'https://capline-group-maps.web.app')});

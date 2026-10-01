/* Source URL is pinned by the publisher, never supplied through the page query. */
const SOURCE=__MAPS_SOURCE_URL__;
const source=new URL(SOURCE),frame=document.getElementById('map'),status=document.getElementById('status'),message=document.getElementById('message'),retry=document.getElementById('retry');
let timer;
function load(){
 const target=new URL(SOURCE),path=location.pathname;
 if(/^\/Capline-Group\/Maps\/Tajikistan\/[^/]+\/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\/?$/.test(path)||path==='/admin'||path==='/admin/')target.pathname+=path.slice(1);
 target.search=location.search;target.searchParams.set('parentOrigin',location.origin);
 status.style.display='grid';message.textContent='Открываем карту…';retry.style.display='none';
 clearTimeout(timer);timer=setTimeout(()=>{message.textContent='Карта ещё загружается. Проверьте соединение.';retry.style.display='inline-block'},20000);
 frame.src=target.href;
}
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||event.origin!==source.origin)return;
 if(event.data?.type==='cavi:ready'){clearTimeout(timer);status.style.display='none';return}
 if(event.data?.type!=='cavi:view')return;
 const {lat,lon,zoom,city}=event.data;
 if(![lat,lon,zoom].every(Number.isFinite)||lat<35.5||lat>42||lon<66||lon>76.5||zoom<4||zoom>20||typeof city!=='string'||city.length>100)return;
 const next=new URL(location.href);next.pathname=`/Capline-Group/Maps/Tajikistan/${encodeURIComponent(city)}/${lat.toFixed(6)},${lon.toFixed(6)}`;next.searchParams.set('z',zoom.toFixed(2));history.replaceState(null,'',next);
});
retry.addEventListener('click',load);window.addEventListener('popstate',load);load();

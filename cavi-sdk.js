/* Embed the map; keep REST API secrets on your taxi server. */
(function(global){
 global.CaviMap = class {
  constructor(element, {mapUrl}) {
   const url=new URL(mapUrl);if(!['https:','http:'].includes(url.protocol))throw Error('Invalid map URL');
   url.searchParams.set('parentOrigin',location.origin);this.origin=url.origin;this.frame=document.createElement('iframe');this.frame.src=url.href;this.frame.title='Cavi Maps';this.frame.style='width:100%;height:100%;border:0';this.ready=false;this.pending=null;
   this.receive=event=>{if(event.origin===this.origin&&event.source===this.frame.contentWindow&&event.data?.type==='cavi:ready'){this.ready=true;if(this.pending)this.setRoute(this.pending)}};
   window.addEventListener('message',this.receive);element.replaceChildren(this.frame);
  }
  setRoute(geometry){if(geometry?.type!=='LineString')throw Error('Expected GeoJSON LineString');this.pending=geometry;if(this.ready)this.frame.contentWindow.postMessage({type:'cavi:route',coordinates:geometry.coordinates},this.origin);}
  destroy(){window.removeEventListener('message',this.receive);this.frame.remove();}
 };
})(window);

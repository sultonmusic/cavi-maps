import {roadPoint,type Road} from './street-index';
export type MapPlace={id:string;lat:number;lon:number;tags:Record<string,string>};
export type District={id:string;name:string;center:[number,number];namingStatus:'proposed';geometry:{type:'Polygon'|'MultiPolygon';coordinates:any};bbox:number[]};
const inShaydon=(lat:number,lon:number)=>lat>=40.638&&lat<=40.68&&lon>=70.335&&lon<=70.386;
export function roadPlace(road:Road,point=roadPoint(road)):MapPlace|null{
 if(!point)return null;const proposed=road.namingStatus==='proposed';
 return {id:'street:'+road.id,lat:point.lat,lon:point.lon,tags:{...road.tags,name:road.name||road.ref||'Безымянный проезд','name:ru':road.name||road.ref||'Безымянный проезд','atlas:type':'street','atlas:naming':proposed?'proposed':'source','atlas:road-id':road.id,'addr:city':inShaydon(point.lat,point.lon)?'Шайдон':road.tags?.['addr:city']||'Таджикистан'}};
}
export function districtPlace(d:District,point={lon:d.center[0],lat:d.center[1]}):MapPlace{return {id:'district:'+d.id,lat:point.lat,lon:point.lon,tags:{name:d.name,'atlas:type':'district','atlas:naming':'proposed','atlas:district-id':d.id,'addr:city':'Шайдон'}}}
function inRing(x:number,y:number,ring:number[][]){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside}return inside}
export function districtAt(districts:District[],lat:number,lon:number){return districts.find(d=>{if(lon<d.bbox[0]||lat<d.bbox[1]||lon>d.bbox[2]||lat>d.bbox[3])return false;const polygons=d.geometry.type==='Polygon'?[d.geometry.coordinates]:d.geometry.coordinates;return polygons.some((rings:number[][][])=>inRing(lon,lat,rings[0])&&!rings.slice(1).some(ring=>inRing(lon,lat,ring)))})||null}

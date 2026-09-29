import {GLYPHS} from '@/lib/poi-glyphs.mjs';
import {glyphOf} from '@/lib/poi-draw';

/** A place's map pictogram as an inline icon (lucide-sized, currentColor), so a list matches the map's discs. */
export default function PoiGlyph({icon,size=22,strokeWidth=2}:{icon:string;size?:number;strokeWidth?:number}){
 const glyph=glyphOf(icon)??GLYPHS['map-pin'];
 return <svg className="poi-glyph" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
  {glyph?.s.map((d,i)=><path key={'s'+i} d={d}/>)}
  {glyph?.f?.map((d,i)=><path key={'f'+i} d={d} fill="currentColor"/>)}
 </svg>;
}

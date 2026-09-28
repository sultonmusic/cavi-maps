"""Apply a local visual road style by matching exact source geometry, not road colour.
Input: public/atlas-data/shaydon-r303-source.json. Does not modify source surface tags.
"""
from pathlib import Path
from shapely.geometry import LineString,Point,box
from shapely.ops import transform
import math,json,collections
root=Path(__file__).resolve().parents[1];out=root/'public/atlas-data'
source=json.loads((out/'shaydon-r303-source.json').read_text(encoding='utf-8'))
def project(lon,lat):return ((lon+180)/360,(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2)
def lines(g):
 if g.is_empty:return []
 if g.geom_type=='LineString':return [g]
 return [l for part in getattr(g,'geoms',[]) for l in lines(part)]
def ring(g):return [[round(x),round(y)] for x,y in g.coords]
def key(f):return json.dumps(f[:3],separators=(',',':'))
bundles={};expected=collections.defaultdict(dict)
west,south,east,north=source['selection_bbox']
fx0,fy1=project(west,south);fx1,fy0=project(east,north)
for feature in source['features']:
 g=transform(project,LineString(feature['geometry']['coordinates']))
 for z in (10,13):
  n=2**z;simple=g.simplify(.55/(256*n),preserve_topology=False)
  x0,y0,x1,y1=simple.bounds
  for x in range(math.floor(x0*n),math.floor(x1*n)+1):
   for y in range(math.floor(y0*n),math.floor(y1*n)+1):
    b=2/(256*n);clipped=simple.intersection(box(x/n-b,y/n-b,(x+1)/n+b,(y+1)/n+b))
    for part in lines(clipped):
     pp=[[[round((px*n-x)*4096),round((py*n-y)*4096)] for px,py in part.coords]]
     f=['road-secondary',0,pp]
     expected[f'{z}-{x}-{y}.json'][key(f)]=(feature,g,simple)
matched=0;styled=0;changed=set();ways=set();pending=[]
for tile,lookup in expected.items():
 z,x,y=map(int,tile[:-5].split('-'));n=2**z;bundle=f'bundle-{z}-{x//4}-{y//4}.json'
 if bundle not in bundles:bundles[bundle]=json.loads((out/bundle).read_text(encoding='utf-8'))
 fs=bundles[bundle][tile]
 if any(len(f)>3 and f[3].get('style')=='asphalt' for f in fs):raise SystemExit('Shaydon style is already applied. Restore original bundles before rerunning.')
 bounds=box((fx0*n-x)*4096,(fy0*n-y)*4096,(fx1*n-x)*4096,(fy1*n-y)*4096)
 updated=[]
 for f in fs:
  hit=lookup.pop(key(f),None)
  if not hit:updated.append(f);continue
  matched+=1;feature,g,simple=hit;local=LineString(f[2][0]);inside=lines(local.intersection(bounds))
  if not inside:updated.append(f);continue
  for part in lines(local.difference(bounds)):
   points=ring(part)
   if len(set(map(tuple,points)))>=2:updated.append([f[0],0,[points]])
  for part in inside:
   points=ring(part)
   if len(set(map(tuple,points)))<2:continue
   p=Point((points[0][0]/4096+x)/n,(points[0][1]/4096+y)/n)
   updated.append([f[0],0,[points],{'style':'asphalt','ref':'R-303','way':feature['properties']['osm_way_id'],'offsets':[round(simple.project(p)*n*4096,3)]}])
   styled+=1;ways.add(feature['id'])
  changed.add(bundle)
 if lookup:raise AssertionError(f'Unmatched source road fragments in {tile}: {len(lookup)}')
 bundles[bundle][tile]=updated
assert styled>0 and len(ways)==len(source['features']),(styled,ways)
for bundle in changed:(out/bundle).write_text(json.dumps(bundles[bundle],ensure_ascii=False,separators=(',',':')),encoding='utf-8')
index=json.loads((out/'index.json').read_text(encoding='utf-8'))
for label in index['labels']:
 if label[2]=='Shaydon' and fx0<label[0]<fx1 and fy0<label[1]<fy1:label[2]='Шайдон'
nx,ny=project(70.361596,40.6604891)
index['labels'].insert(0,[nx,ny,'R-303','road',14])
(out/'index.json').write_text(json.dumps(index,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
report={'style':'asphalt','scope':'Shaydon R-303 and connecting bridge','source_date':'2026-09-06','bbox':source['selection_bbox'],'way_ids':sorted(ways),'matched_source_fragments':matched,'styled_fragments':styled,'bundles':sorted(changed),'note':'Visual treatment requested by user. Source road surface is unspecified. Dashed centre lines are illustrative.'}
(out/'shaydon-style.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))

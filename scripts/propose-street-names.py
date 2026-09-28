"""Local Atlas proposals, never an official renaming or change to the source tags."""
from pathlib import Path
from collections import defaultdict
import json,math
from shapely.geometry import LineString,box
root=Path(__file__).resolve().parents[1];p=root/'public/streets.json';data=json.loads(p.read_text(encoding='utf-8'))
bounds=box(70.335,40.638,70.386,40.68)
eligible=[]
def length(coords):return sum(math.hypot((b[0]-a[0])*84400,(b[1]-a[1])*111195) for a,b in zip(coords,coords[1:]))
for road in data['roads']:
 if road.get('namingStatus')=='proposed':road['name']=None;road.pop('groupId',None)
 road['namingStatus']='source'
 if road.get('name') or road.get('ref') or road['tags'].get('highway') not in ('residential','unclassified','living_street','tertiary'):continue
 line=LineString(road['coordinates'])
 if length(road['coordinates'])<65 or line.intersection(bounds).length/max(line.length,1e-10)<.9:continue
 eligible.append(road)
parent=list(range(len(eligible)))
def find(i):
 while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
 return i
ends=defaultdict(list)
for i,r in enumerate(eligible):
 for reverse in (False,True):
  coords=r['coordinates'][::-1] if reverse else r['coordinates'];a=coords[0]
  b=next((q for q in coords[1:] if math.hypot((q[0]-a[0])*84400,(q[1]-a[1])*111195)>12),coords[-1])
  v=((b[0]-a[0])*84400,(b[1]-a[1])*111195);d=math.hypot(*v)
  if d:ends[tuple(round(v,6) for v in a)].append((i,(v[0]/d,v[1]/d)))
for candidates in ends.values():
 for i,a in candidates:
  for j,b in candidates:
   if i<j and a[0]*b[0]+a[1]*b[1]<-math.cos(math.radians(20)):parent[find(j)]=find(i)
groups=defaultdict(list)
for i,r in enumerate(eligible):groups[find(i)].append(r)
proposals=[];labels=[]
ordered=sorted(groups.values(),key=lambda group:(-max(r['bbox'][3] for r in group),min(r['bbox'][0] for r in group)))
for number,group in enumerate(ordered):
 name=f'Улица {number+1}';gid=f'atlas-shaydon-street-{number+1:03}'
 for road in group:road['name']=name;road['namingStatus']='proposed';road['groupId']=gid
 longest=max(group,key=lambda r:length(r['coordinates']));pt=LineString(longest['coordinates']).interpolate(.5,normalized=True)
 nx=(pt.x+180)/360;ny=(1-math.asinh(math.tan(math.radians(pt.y)))/math.pi)/2
 labels.append([nx,ny,name,'road',16,20])
 proposals.append({'id':gid,'name':name,'ways':[r['id'] for r in group],'center':[pt.x,pt.y],'namingStatus':'proposed'})
data['localNaming']={'status':'proposed','authority':'Atlas','official':False,'note':'Проектная нумерация с севера на юг, при равной северной границе — с запада на восток. Исходные теги сохранены.','groupCount':len(proposals),'wayCount':len(eligible)}
p.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
(root/'public/atlas-data/street-name-proposals.json').write_text(json.dumps({'official':False,'proposals':proposals},ensure_ascii=False,indent=2),encoding='utf-8')
indexp=root/'public/atlas-data/index.json';index=json.loads(indexp.read_text(encoding='utf-8'))
index['labels']=[l for l in index['labels'] if len(l)<7 or l[6]!='atlas-street-proposal']
index['labels'].extend([*l,'atlas-street-proposal'] for l in labels)
indexp.write_text(json.dumps(index,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
print(f'{len(proposals)} proposed street names on {len(eligible)} source ways; all original named/ref roads retained')

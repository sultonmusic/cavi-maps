"""Number existing proposals without rebuilding or changing any source geometry.

Also attaches stable owners to label metadata for real-time admin name edits.
Run after propose-street-names.py / propose-shaydon-districts.py on a fresh export.
"""
from pathlib import Path
from collections import defaultdict
import json, math, sys
from shapely.geometry import LineString, Point

sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).resolve().parents[1]
def read(name):return json.loads((root/name).read_text(encoding='utf-8'))
def write(name,data): (root/name).write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
def project(lon,lat):return ((lon+180)/360,(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2)
streets=read('public/streets.json');districts=read('public/districts.json');meta=read('public/atlas-data/index.json')
proposals=read('public/atlas-data/street-name-proposals.json')
groups=defaultdict(list)
for road in streets['roads']:
 if road.get('namingStatus')=='proposed':groups[road['groupId']].append(road)
ordered=sorted(groups.items(),key=lambda item:(-max(r['bbox'][3] for r in item[1]),min(r['bbox'][0] for r in item[1]),item[0]))
names={gid:f'Улица {i+1}' for i,(gid,_) in enumerate(ordered)}
old_proposed={}
for gid,roads in groups.items():
 for road in roads:old_proposed[road['name']]=gid;road['name']=names[gid]
for entry in proposals['proposals']:entry['name']=names[entry['id']]
proposals['proposals'].sort(key=lambda entry:int(entry['name'].split()[-1]))
proposals['numbering']='С севера на юг по северной границе улицы; при равенстве — с запада на восток.'
streets['localNaming']['note']='Проектная нумерация с севера на юг. Исходные названия, теги и геометрия сохранены.'
streets['localNaming']['numbering']=proposals['numbering']
old_districts={}
for number,district in enumerate(sorted(districts['districts'],key=lambda d:(-d['bbox'][3],d['bbox'][0],d['id'])),1):
 old_districts[district['name']]=district['id'];district['name']=f'{number} микрорайон'
district_names={d['id']:d['name'] for d in districts['districts']}
districts['description']='Проектные микрорайоны 1–4, пронумерованные с севера на юг. Неофициальное деление застройки Шайдона; границы не являются административными.'

# Original road labels were exported without IDs. Match their original text and
# near-exact midpoint to existing source geometry, never to an unrelated road.
by_name=defaultdict(list)
for road in streets['roads']:
 if road.get('namingStatus')=='proposed':continue
 line=LineString([project(*point) for point in road['coordinates']])
 aliases={road.get('name'),road.get('ref'),*(road['tags'].get(key) for key in ('name','name:ru','name:en','name:tg','ref'))}-{None,''}
 for alias in aliases:by_name[alias].append((road['id'],line))
matched=0
for label in meta['labels']:
 marker=label[6] if len(label)>6 else None
 if marker=='atlas-street-proposal':
  gid=label[7] if len(label)>7 and label[7] in names else old_proposed.get(label[2])
  if gid:label[2]=names[gid];label[:]=label[:7]+[gid]
 elif marker=='atlas-district-proposal':
  did=label[7] if len(label)>7 and label[7] in district_names else old_districts.get(label[2])
  if did:label[2]=district_names[did];label[:]=label[:7]+[did]
 elif label[3]=='road':
  candidates=by_name.get(label[2],[])
  if not candidates:continue
  point=Point(label[0],label[1]);road_id,line=min(candidates,key=lambda pair:pair[1].distance(point))
  # 1e-6 world units is ~30 m here; original midpoint matches are much closer.
  if line.distance(point)<=1e-6:
   while len(label)<6:label.append(None)
   label[:]=label[:6]+['atlas-road-source',road_id];matched+=1
write('public/streets.json',streets);write('public/districts.json',districts)
write('public/atlas-data/index.json',meta);write('public/atlas-data/street-name-proposals.json',proposals)
print(f'Numbered {len(names)} street groups and {len(district_names)} districts; linked {matched} source road labels. Geometry and source names untouched.')

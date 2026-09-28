import pathlib,osmium,json,math
from shapely.geometry import LineString
root=pathlib.Path(__file__).resolve().parents[1]
# Reuse the same geographic clipping functions without running the full extractor.
ns={'__file__':str(root/'scripts'/'build-atlas.py')}
exec((root/'scripts'/'build-atlas.py').read_text().split("print('Extracting raw geography...'")[0],ns)
refs=set()
class Country(osmium.SimpleHandler):
 def relation(self,r):
  if r.tags.get('ISO3166-1')=='TJ' and r.tags.get('admin_level')=='2':
   refs.update(m.ref for m in r.members if m.type=='w')
Country().apply_file(str(root.parent/'tajikistan.osm.pbf'))
class Lines(osmium.SimpleHandler):
 def way(self,w):
  if w.id not in refs:return
  c=[(n.lon,n.lat) for n in w.nodes if n.location.valid()]
  if len(c)>1:ns['add_geometry'](LineString(c),'border',7)
Lines().apply_file(str(root.parent/'tajikistan.osm.pbf'),locations=True,idx='flex_mem')
out=root/'public'/'atlas-data';meta=json.loads((out/'index.json').read_text(encoding='utf-8'))
for (z,x,y),fs in ns['tiles'].items():
 name=f'{z}-{x}-{y}.json';p=out/name
 old=json.loads(p.read_text(encoding='utf-8')) if p.exists() else []
 old=[f for f in old if f[0]!='border'];old+=fs
 p.write_text(json.dumps(old,separators=(',',':')),encoding='utf-8')
 if name not in meta['tiles']:meta['tiles'].append(name)
x,y=ns['project'](70.7,38.75);meta['labels'].insert(0,[x,y,'TOJIKISTON','country',6])
meta['counts']['national-border-segments']=len(refs)
(out/'index.json').write_text(json.dumps(meta,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
print('Country border:',len(refs),'segments',len(ns['tiles']),'tiles',flush=True)

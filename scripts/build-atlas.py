import osmium, json, math, collections, pathlib, sys, time
from shapely.geometry import LineString, Polygon, box
from shapely.ops import transform
from shapely import wkb
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'public'/'atlas-data'; OUT.mkdir(exist_ok=True)
tiles=collections.defaultdict(list); counts=collections.Counter(); labels=[]; pois={}; graph_nodes={}; graph_edges=[]
TIERS=(7,10,13)
def project(lon,lat):
    return ((lon+180)/360,(1-math.asinh(math.tan(math.radians(max(-85,min(85,lat)))))/math.pi)/2)
def project_geom(g):
    return transform(lambda x,y,z=None:project(x,y),g)
def paths(g):
    if g.is_empty:return []
    if g.geom_type=='Polygon':return [[list(g.exterior.coords)]+[list(r.coords) for r in g.interiors]]
    if g.geom_type in ('LineString','LinearRing'):return [[list(g.coords)]]
    if hasattr(g,'geoms'):return [p for gg in g.geoms for p in paths(gg)]
    return []
def add_geometry(g,kind,minz=7,name=''):
    if g.is_empty:return
    if not g.is_valid:g=g.buffer(0)
    if g.is_empty:return
    g=project_geom(g); counts[kind]+=1
    poly=g.geom_type in ('Polygon','MultiPolygon')
    for z in TIERS:
        if z<minz:continue
        n=2**z
        simple=g if kind=='building' else g.simplify(.55/(256*n),preserve_topology=poly)
        if poly and kind!='building' and simple.area*n*n*65536<2:continue
        x0,y0,x1,y1=simple.bounds
        for x in range(math.floor(x0*n),math.floor(x1*n)+1):
            for y in range(math.floor(y0*n),math.floor(y1*n)+1):
                # Include a small buffer so road strokes remain seamless.
                b=2/(256*n)
                clipped=simple.intersection(box(x/n-b,y/n-b,(x+1)/n+b,(y+1)/n+b))
                for rings in paths(clipped):
                    pp=[[[round((px*n-x)*4096),round((py*n-y)*4096)] for px,py in ring] for ring in rings]
                    if not pp:continue
                    tiles[(z,x,y)].append([kind,1 if poly else 0,pp])
    if name and kind.startswith('road'):
        p=g.interpolate(.5,normalized=True)
        labels.append([p.x,p.y,name,'road',13])
class Extract(osmium.SimpleHandler):
    processed=0
    def report(self):
        self.processed+=1
        if self.processed%50000==0:print('Processed',self.processed,'objects;',sum(counts.values()),'features;',len(tiles),'tiles',flush=True)
    def node(self,o):
        self.report()
        if len(o.tags)==0:return
        t=dict(o.tags)
        if t.get('place') in ('city','town','village','hamlet') and t.get('name'):
            x,y=project(o.lon,o.lat); labels.append([x,y,t.get('name:uz',t.get('name:en',t['name'])),t['place'],7 if t['place']=='city' else 10 if t['place']=='town' else 13])
        if t.get('name') and any(k in t for k in ('amenity','tourism','shop')):pois['node/'+str(o.id)]={'id':'node/'+str(o.id),'lat':o.lat,'lon':o.lon,'tags':t}
    def way(self,o):
        self.report()
        t=dict(o.tags)
        interesting=any(k in t for k in ('highway','waterway','railway','boundary','amenity','tourism','shop'))
        if not interesting:return
        coords=[(p.lon,p.lat) for p in o.nodes if p.location.valid()]
        if len(coords)<2:return
        g=LineString(coords)
        if t.get('name') and any(k in t for k in ('amenity','tourism','shop')):
            p=g.centroid;pois['way/'+str(o.id)]={'id':'way/'+str(o.id),'lat':p.y,'lon':p.x,'tags':t}
        h=t.get('highway','')
        if h:
            if h in ('motorway','motorway_link','trunk','trunk_link','primary','primary_link'):kind,minz='road-main',7
            elif h in ('secondary','secondary_link','tertiary','tertiary_link'):kind,minz='road-secondary',10
            elif h in ('footway','path','steps','cycleway','bridleway','track'):kind,minz='path',13
            else:kind,minz='road-local',13
            add_geometry(g,kind,minz,t.get('name',''))
            if h in ('motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service') and t.get('access') not in ('private','no') and t.get('motor_vehicle') not in ('no','private'):
                ns=[p for p in o.nodes if p.location.valid()]
                one=t.get('oneway') in ('yes','1','true') or (t.get('junction')=='roundabout' and t.get('oneway')!='no')
                if t.get('oneway')=='-1':ns=ns[::-1];one=True
                for a,b in zip(ns,ns[1:]):
                    graph_nodes[a.ref]=[round(a.lat,6),round(a.lon,6)];graph_nodes[b.ref]=[round(b.lat,6),round(b.lon,6)]
                    graph_edges.append((a.ref,b.ref,one))
        elif t.get('waterway') in ('river','stream','canal'):add_geometry(g,'river',7 if t['waterway']=='river' else 13)
        elif t.get('railway')=='rail':add_geometry(g,'rail',10)
        elif t.get('boundary')=='administrative' and t.get('admin_level')=='2':add_geometry(g,'border',7)
    def area(self,o):
        self.report()
        t=dict(o.tags);kind=None;minz=10
        if 'building' in t and t['building']!='no':kind,minz='building',13
        elif t.get('natural')=='water' or t.get('landuse') in ('reservoir','basin'):kind,minz='water',7
        elif t.get('landuse') in ('forest','meadow','grass','orchard','farmland','vineyard') or t.get('natural') in ('wood','scrub','grassland'):kind='green'
        elif t.get('leisure') in ('park','garden','pitch','golf_course'):kind='park'
        elif t.get('landuse') in ('residential','industrial','commercial','retail'):kind='urban'
        elif t.get('natural') in ('glacier','bare_rock','scree'):kind,minz='rock',7
        if kind:
            try:add_geometry(wkb.loads(osmium.geom.WKBFactory().create_multipolygon(o),hex=True),kind,minz)
            except Exception as e:counts['invalid_geometry']+=1
        if not o.from_way() and t.get('name') and any(k in t for k in ('amenity','tourism','shop')):
            try:
                p=wkb.loads(osmium.geom.WKBFactory().create_multipolygon(o),hex=True).representative_point();id='relation/'+str(o.orig_id());pois[id]={'id':id,'lat':p.y,'lon':p.x,'tags':t}
            except Exception:pass
print('Extracting raw geography...',flush=True)
Extract().apply_file(str(ROOT.parent/'tajikistan.osm.pbf'),locations=True,idx='flex_mem')
print('Writing tiles',len(tiles),dict(counts),flush=True)
order={'rock':0,'urban':1,'green':2,'park':3,'water':4,'building':5,'river':6,'path':7,'rail':8,'road-local':9,'road-secondary':10,'road-main':11,'border':12}
manifest=[]
for (z,x,y),features in tiles.items():
    name=f'{z}-{x}-{y}.json';manifest.append(name)
    features.sort(key=lambda f:order.get(f[0],0))
    (OUT/name).write_text(json.dumps(features,separators=(',',':'),ensure_ascii=False),encoding='utf-8')
(OUT/'index.json').write_text(json.dumps({'tiles':manifest,'tiers':TIERS,'counts':dict(counts),'source':'OpenStreetMap contributors / Geofabrik','date':'2026-09-06','labels':labels},ensure_ascii=False,separators=(',',':')),encoding='utf-8')
(ROOT/'public'/'places.json').write_text(json.dumps(list(pois.values()),ensure_ascii=False,separators=(',',':')),encoding='utf-8')
ids={id:i for i,id in enumerate(graph_nodes)};nodes=list(graph_nodes.values());edges=[[ids[a],ids[b],1 if one else 0] for a,b,one in graph_edges]
(ROOT/'public'/'road-graph.json').write_text(json.dumps({'nodes':nodes,'edges':edges},separators=(',',':')),encoding='utf-8')
print('Complete',len(pois),'places;',len(nodes),'routing nodes;',len(edges),'edges;',len(labels),'labels',flush=True)

# All files are closed and the completion message is flushed. Avoid expensive
# Python object teardown on memory-constrained Windows machines.
import os
os._exit(0)

import json,pathlib
root=pathlib.Path(__file__).resolve().parents[1];p=root/'public'/'road-graph.json'
g=json.loads(p.read_text(encoding='utf-8'));meta={}
for kind,size in [('nodes',100000),('edges',200000)]:
 files=[]
 for i in range(0,len(g[kind]),size):
  name=f'graph-{kind}-{i//size}.json';(root/'public'/name).write_text(json.dumps(g[kind][i:i+size],separators=(',',':')),encoding='utf-8');files.append('/'+name)
 meta[kind+'_files']=files
p.write_text(json.dumps(meta,separators=(',',':')),encoding='utf-8')
print('Graph split into',sum(map(len,meta.values())),'files',flush=True)

import json,pathlib,collections
root=pathlib.Path(__file__).resolve().parents[1];d=root/'public'/'atlas-data'
meta=json.loads((d/'index.json').read_text(encoding='utf-8'));groups=collections.defaultdict(list)
for name in meta['tiles']:
 z,x,y=map(int,name[:-5].split('-'));groups[f'bundle-{z}-{x//4}-{y//4}.json'].append(name)
for target,names in groups.items():
 content='{'+','.join(json.dumps(name)+':'+(d/name).read_text(encoding='utf-8') for name in names)+'}'
 (d/target).write_text(content,encoding='utf-8')
for name in meta['tiles']:
 p=(d/name).resolve();assert p.parent==d.resolve();p.unlink()
meta['bundleSize']=4;(d/'index.json').write_text(json.dumps(meta,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
print('Bundled',len(meta['tiles']),'tiles into',len(groups),'files',flush=True)

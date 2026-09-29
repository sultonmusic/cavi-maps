"""Tell the map tiles which road lines are asphalt.

The public/atlas-data bundles draw every street as a line. public/atlas-roads draws the streets
OpenStreetMap paves: a grey line below zoom 16, to scale from zoom 16. Nothing linked the two, so a
paved street was drawn twice, and its plain line showed beside the grey asphalt.

This script rebuilds every road line in the bundles (road-local, road-secondary and road-main,
tiers 7, 10 and 13) from the OpenStreetMap extract public/atlas-roads was built from, simplified
and cut exactly as build-atlas.py cuts them, and gives each line its way id:

    [kind, 0, rings, {"way": <OSM way id>}]
    [kind, 0, rings, {"way": <OSM way id>, "style": "asphalt"}]   when public/atlas-roads draws the way

Everything else in the bundles (areas, buildings, rivers, paths, rail, borders) stays as it is, in
its order. Highways that are not roads are left out: proposed, planned, abandoned or razed roads,
platforms, corridors, rest areas and other outlines tagged area=yes. The script is idempotent and
supersedes style-shaydon.py. Run it after build-country-roads.py and bundle-tiles.py, and again
whenever either is rebuilt, with the same extract as public/atlas-roads. Nothing else may write
the bundles while it runs.

    python scripts/flag-asphalt-roads.py [../tajikistan.osm.pbf] [--data public/atlas-data]
        [--roads public/atlas-roads] [--min-asphalt 3000] [--dry-run]

It writes the bundles that change, new bundles and index.json `tiles` only if a road reaches a
tile the map did not have, and the report road-flags.json. It exits with 1 when an asphalt street
of public/atlas-roads has no way in the extract (built from a different extract). Check the result
with node scripts/check-road-flags.mjs.
"""
import argparse
import collections
import json
import math
import os
import pathlib
import sys
import time

import osmium
import shapely
from shapely.geometry import LineString

ROOT = pathlib.Path(__file__).resolve().parents[1]
TIERS = (7, 10, 13)
ROAD_KINDS = ('road-local', 'road-secondary', 'road-main')
MAIN = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'}
SECONDARY = {'secondary', 'secondary_link', 'tertiary', 'tertiary_link'}
# build-atlas.py draws these as the 'path' kind, which this script leaves alone.
PATHS = {'footway', 'path', 'steps', 'cycleway', 'bridleway', 'track'}
NOT_ROADS = {'proposed', 'planned', 'abandoned', 'disused', 'razed', 'dismantled', 'demolished', 'removed',
             'no', 'platform', 'corridor', 'elevator', 'bus_stop', 'services', 'rest_area', 'emergency_bay'}
# Feature order in a tile, as build-atlas.py sorts it: roads draw above rail and below borders.
ORDER = {'rock': 0, 'urban': 1, 'green': 2, 'park': 3, 'water': 4, 'building': 5, 'river': 6, 'path': 7, 'rail': 8,
         'road-local': 9, 'road-secondary': 10, 'road-main': 11, 'border': 12}
RULE = 'a road line is asphalt exactly when public/atlas-roads draws its way'
DUMP = {'separators': (',', ':'), 'ensure_ascii': False}


def project(lon, lat):
    """Web Mercator in 0..1, exactly as build-atlas.py projects."""
    return ((lon + 180) / 360, (1 - math.asinh(math.tan(math.radians(max(-85, min(85, lat))))) / math.pi) / 2)


def paths(g):
    if g.is_empty:
        return []
    if g.geom_type == 'Polygon':
        return [[list(g.exterior.coords)] + [list(r.coords) for r in g.interiors]]
    if g.geom_type in ('LineString', 'LinearRing'):
        return [[list(g.coords)]]
    if hasattr(g, 'geoms'):
        return [p for gg in g.geoms for p in paths(gg)]
    return []


def kind_of(highway):
    if highway in MAIN:
        return 'road-main', 7
    if highway in SECONDARY:
        return 'road-secondary', 10
    return 'road-local', 13


class Roads(osmium.SimpleHandler):
    """Cuts every road way into tier tiles, keeping each piece as its finished JSON text."""

    def __init__(self, asphalt):
        super().__init__()
        self.asphalt = asphalt
        # (z, x, y) -> JSON texts of the road pieces, one list per kind in drawing order
        self.tiles = collections.defaultdict(lambda: ([], [], []))
        self.counts = collections.Counter()
        self.skipped = collections.Counter()
        self.flagged = set()
        self.processed = 0

    def way(self, o):
        self.processed += 1
        if self.processed % 50000 == 0:
            print('Processed', self.processed, 'highways;', len(self.tiles), 'tiles', flush=True)
        tags = o.tags
        highway = tags.get('highway')
        if not highway or highway in PATHS:
            return
        if highway in NOT_ROADS:
            self.skipped['not_a_road'] += 1
            return
        if tags.get('area') == 'yes':
            self.skipped['area'] += 1
            return
        coords = [project(p.lon, p.lat) for p in o.nodes if p.location.valid()]
        if len(coords) < 2:
            self.skipped['no_location'] += 1
            return
        g = LineString(coords)
        # build-atlas turns an invalid line (fewer than two distinct points) into an empty buffer.
        if g.is_empty or not g.is_valid:
            self.skipped['invalid'] += 1
            return
        kind, minz = kind_of(highway)
        slot = ROAD_KINDS.index(kind)
        asphalt = o.id in self.asphalt
        props = {'way': o.id, 'style': 'asphalt'} if asphalt else {'way': o.id}
        self.counts[kind] += 1
        for z in TIERS:
            if z < minz:
                continue
            n = 2 ** z
            simple = g.simplify(.55 / (256 * n), preserve_topology=False)
            x0, y0, x1, y1 = simple.bounds
            cells = [(x, y) for x in range(math.floor(x0 * n), math.floor(x1 * n) + 1)
                     for y in range(math.floor(y0 * n), math.floor(y1 * n) + 1)]
            # Include a small buffer so road strokes remain seamless (as build-atlas.py does).
            b = 2 / (256 * n)
            boxes = shapely.box([x / n - b for x, _ in cells], [y / n - b for _, y in cells],
                                [(x + 1) / n + b for x, _ in cells], [(y + 1) / n + b for _, y in cells])
            for (x, y), clipped in zip(cells, shapely.intersection(simple, boxes)):
                for rings in paths(clipped):
                    pp = [[[round((px * n - x) * 4096), round((py * n - y) * 4096)] for px, py in ring] for ring in rings]
                    if not pp:
                        continue
                    self.tiles[(z, x, y)][slot].append(json.dumps([kind, 0, pp, props], **DUMP))
                    self.counts[f'{z}:{kind}'] += 1
                    if asphalt:
                        self.counts[f'{z}:{kind}:asphalt'] += 1
                        if z == 13:
                            self.flagged.add(o.id)


def asphalt_ways(folder):
    """Way ids of every street public/atlas-roads draws, from the files its index lists."""
    meta = json.loads((folder / 'index.json').read_text(encoding='utf-8'))
    ways = set()
    for name in meta['groups']:
        for record in json.loads((folder / f'{name}.json').read_text(encoding='utf-8'))['roads']:
            ways.add(record[0])
    return ways, meta.get('source', '')


def tile_text(name, features, roads):
    """One tile of a bundle: its own features less the old road lines, the new ones in their place."""
    kept = [f for f in features if f[0] not in ROAD_KINDS]
    at = next((i for i, f in enumerate(kept) if ORDER.get(f[0], 0) > ORDER['road-main']), len(kept))
    texts = [json.dumps(f, **DUMP) for f in kept[:at]] + roads + [json.dumps(f, **DUMP) for f in kept[at:]]
    return json.dumps(name) + ':[' + ','.join(texts) + ']'


def tile_order(name):
    return tuple(int(part) for part in name[:-5].split('-'))


def main():
    parser = argparse.ArgumentParser(description='Link the road lines of the map tiles to their OpenStreetMap ways and mark the asphalt ones.')
    parser.add_argument('pbf', nargs='?', default=str(ROOT.parent / 'tajikistan.osm.pbf'),
                        help='OpenStreetMap extract (.osm.pbf or .osm), the one public/atlas-roads was built from')
    parser.add_argument('--data', default=str(ROOT / 'public' / 'atlas-data'), help='folder of bundle-*.json and index.json')
    parser.add_argument('--roads', default=str(ROOT / 'public' / 'atlas-roads'), help='folder of the asphalt streets')
    parser.add_argument('--min-asphalt', type=int, default=3000, help='refuse to run with fewer asphalt streets than this')
    parser.add_argument('--dry-run', action='store_true', help='report what would change and write nothing')
    args = parser.parse_args()
    pbf, data, roads_folder = pathlib.Path(args.pbf), pathlib.Path(args.data), pathlib.Path(args.roads)
    if not pbf.is_file():
        raise SystemExit(f'No OpenStreetMap extract at {pbf}')
    started = time.time()

    asphalt, roads_source = asphalt_ways(roads_folder)
    if len(asphalt) < args.min_asphalt:
        raise SystemExit(f'Only {len(asphalt)} asphalt streets in {roads_folder}; expected at least {args.min_asphalt}')
    meta = json.loads((data / 'index.json').read_text(encoding='utf-8'))
    size = meta.get('bundleSize', 4)
    known = set(meta['tiles'])
    print(f'{len(asphalt)} asphalt streets in {roads_folder.name}; reading {pbf.name}', flush=True)

    handler = Roads(asphalt)
    # The node locations are stored before the filter, so only highways reach Python.
    handler.apply_file(str(pbf), locations=True, idx='flex_mem', filters=[osmium.filter.KeyFilter('highway')])
    print(f'Cut {sum(handler.counts[k] for k in ROAD_KINDS)} roads into {len(handler.tiles)} tiles '
          f'in {time.time() - started:.0f} s', flush=True)

    # bundle file -> tile name -> JSON texts of its road lines
    fresh = collections.defaultdict(dict)
    for (z, x, y), groups in handler.tiles.items():
        fresh[f'bundle-{z}-{x // size}-{y // size}.json'][f'{z}-{x}-{y}.json'] = groups[0] + groups[1] + groups[2]
    handler.tiles.clear()
    new_tiles = sorted((name for tiles in fresh.values() for name in tiles if name not in known), key=tile_order)

    changed, created, emptied = [], [], 0
    for path in sorted(data.glob('bundle-*.json')):
        original = path.read_text(encoding='utf-8')
        bundle = json.loads(original)
        roads = fresh.pop(path.name, {})
        parts = []
        for name, features in bundle.items():
            lines = roads.pop(name, [])
            if not lines and any(f[0] in ROAD_KINDS for f in features):
                emptied += 1
            parts.append(tile_text(name, features, lines))
        parts += [tile_text(name, [], roads[name]) for name in sorted(roads, key=tile_order)]
        text = '{' + ','.join(parts) + '}'
        if text != original:
            changed.append(path.name)
            if not args.dry_run:
                path.write_text(text, encoding='utf-8')
    for bundle, roads in sorted(fresh.items()):
        created.append(bundle)
        if not args.dry_run:
            text = '{' + ','.join(tile_text(name, [], roads[name]) for name in sorted(roads, key=tile_order)) + '}'
            (data / bundle).write_text(text, encoding='utf-8')

    if new_tiles and not args.dry_run:
        # Read the index again right before writing, and touch nothing in it but the tile list.
        meta = json.loads((data / 'index.json').read_text(encoding='utf-8'))
        listed = set(meta['tiles'])
        meta['tiles'].extend(name for name in new_tiles if name not in listed)
        (data / 'index.json').write_text(json.dumps(meta, **DUMP), encoding='utf-8')

    missing = sorted(asphalt - handler.flagged)
    report = {
        'source': pbf.name,
        'roads_source': roads_source,
        'rule': RULE,
        'asphalt_ways': len(asphalt),
        'flagged_ways': len(handler.flagged),
        'missing_count': len(missing),
        'missing_ways': missing[:100],
        'roads': {kind: handler.counts[kind] for kind in ROAD_KINDS},
        'features': {key: handler.counts[key] for key in sorted(handler.counts) if ':' in key},
        'skipped': dict(sorted(handler.skipped.items())),
    }
    # The report describes the tiles, not the run, so a rerun that changes nothing leaves it as it was.
    if not args.dry_run:
        (data / 'road-flags.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'missing_ways'}))
    if new_tiles:
        print(f'New tiles ({len(new_tiles)}):', ' '.join(new_tiles[:40]), '...' if len(new_tiles) > 40 else '')
    if created:
        print(f'New bundles ({len(created)}):', ' '.join(created[:40]), '...' if len(created) > 40 else '')
    print(f'{"Would change" if args.dry_run else "Changed"} {len(changed)} bundles and '
          f'{"would create" if args.dry_run else "created"} {len(created)}; {emptied} tiles have no roads now; '
          f'{len(handler.flagged)} of {len(asphalt)} asphalt streets marked, {len(missing)} missing; '
          f'{time.time() - started:.0f} s', flush=True)
    if missing:
        print(f'WARNING: {len(missing)} asphalt streets have no road line in {pbf.name}, so the map draws them only '
              f'from zoom 16 (e.g. way/{", way/".join(map(str, missing[:5]))}). Build public/atlas-roads and these '
              f'tiles from the same extract.', file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    code = main()
    # Everything is written and flushed; skip the slow teardown of large Python objects, as the
    # other builders do.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)

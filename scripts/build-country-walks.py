"""Walkways across Tajikistan from OpenStreetMap, drawn to scale on the 3D map: footways,
sidewalks, paths, steps, cycleways, pedestrian streets and field tracks as strips, and footway or
pedestrian areas as outlines. A strip is as wide as its width tag says, or a usual width for its kind; its
paving comes from the surface tag. Tunnels and indoor ways are left out. Crossings are kept so the
map can paint zebras on the street: footway crossings as lines, and crossing points as single
points.

The output is one small JSON file per zoom-10 tile a walkway reaches, loaded near where the map
looks:

    {"walks": [[shape, surface, width, lon, lat, dlon, dlat, ...], ...]}
    shape 0 a walkway strip, 1 a closed outline, 2 a crossing over a street, 3 a track or
    bridleway strip, 4 a crossing point on a street
    surface 0 plain, 1 paving tiles, 2 asphalt; width in decimetres (0 for an outline or point)
    coordinates in millionths of a degree, each after the first a step from the one before

    python scripts/build-country-walks.py <tajikistan.osm.pbf> public/atlas-walks
"""
import collections
import json
import math
import os
import pathlib
import re
import sys

import osmium

ZOOM = 10
SCALE = 1_000_000
WIDTHS = {'footway': 2.5, 'path': 1.5, 'pedestrian': 5.0, 'steps': 2.5, 'cycleway': 2.0, 'track': 3.0, 'bridleway': 1.5}
TILES = {'paving_stones', 'sett', 'paved', 'concrete:plates', 'unhewn_cobblestone', 'cobblestone', 'stone'}
ASPHALT = {'asphalt', 'concrete', 'concrete:lanes', 'chipseal'}
counts = collections.Counter()


def surface(tags):
    value = tags.get('surface')
    return 1 if value in TILES else 2 if value in ASPHALT else 0


def width(tags):
    match = re.match(r'\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$', tags.get('width') or '')
    stated = float(match.group(1).replace(',', '.')) if match else 0
    if 0.5 <= stated <= 30:
        return stated
    return 2.0 if tags.get('footway') == 'sidewalk' else WIDTHS[tags.get('highway')]


def tile(lon, lat):
    n, sin = 2 ** ZOOM, math.sin(math.radians(lat))
    return math.floor((lon + 180) / 360 * n), math.floor((0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * n)


class Walks(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.files = collections.defaultdict(list)

    def node(self, node):
        tags = node.tags
        if tags.get('highway') != 'crossing' or tags.get('crossing') in ('no', 'unmarked', 'informal'):
            return
        x, y = round(node.location.lon * SCALE), round(node.location.lat * SCALE)
        self.files[tile(x / SCALE, y / SCALE)].append([4, 0, 0, x, y])
        counts['crossing_point'] += 1

    def way(self, way):
        tags = way.tags
        highway = tags.get('highway')
        outline = (highway in ('pedestrian', 'footway') and tags.get('area') == 'yes') or tags.get('area:highway') in ('footway', 'pedestrian')
        if not outline and highway not in WIDTHS:
            return
        if tags.get('tunnel') not in (None, 'no') or tags.get('indoor') not in (None, 'no'):
            counts['left_out'] += 1
            return
        crossing = 'crossing' in (tags.get('footway'), tags.get('cycleway'), tags.get('path'))
        try:
            line = [(node.lon, node.lat) for node in way.nodes]
        except osmium.InvalidLocationError:
            counts['broken'] += 1
            return
        if outline and (len(line) < 4 or line[0] != line[-1]):
            return
        shape = 1 if outline else 2 if crossing else 3 if highway in ('track', 'bridleway') else 0
        record, px, py = [shape, surface(tags), 0 if outline else round(width(tags) * 10)], 0, 0
        for lon, lat in line:
            x, y = round(lon * SCALE), round(lat * SCALE)
            if len(record) > 3 and x == px and y == py:
                continue
            record += (x - px, y - py)
            px, py = x, y
        if len(record) < 7:
            return
        (x0, y1), (x1, y0) = tile(min(p[0] for p in line), min(p[1] for p in line)), tile(max(p[0] for p in line), max(p[1] for p in line))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                self.files[(x, y)].append(record)
        counts['outline' if outline else 'crossing_line' if crossing else f'strip_{highway}'] += 1
        counts[('plain', 'tiles', 'asphalt')[record[1]]] += 1


def main(pbf, destination):
    walks = Walks()
    walks.apply_file(str(pbf), locations=True, idx='flex_mem')
    destination = pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for old in destination.glob('*.json'):
        old.unlink()
    names, total = [], 0
    for (x, y), records in sorted(walks.files.items()):
        text = json.dumps({'walks': records}, separators=(',', ':'))
        (destination / f'{x}-{y}.json').write_text(text, encoding='utf-8')
        names.append(f'{x}-{y}')
        total += len(text)
    index = {'tier': ZOOM, 'groups': names, 'counts': dict(counts), 'licence': 'ODbL',
             'source': 'OpenStreetMap contributors, Geofabrik extract of 12.09.2026'}
    (destination / 'index.json').write_text(json.dumps(index, separators=(',', ':')), encoding='utf-8')
    print(f'Complete: {sum(len(r) for r in walks.files.values())} records in {len(names)} files, {total / 1e6:.2f} MB. {dict(counts)}', flush=True)


if __name__ == '__main__':
    main(*sys.argv[1:3])
    sys.stdout.flush()
    os._exit(0)

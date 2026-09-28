"""Asphalt streets across Tajikistan from OpenStreetMap, so the map draws their asphalt and lanes
without an admin setting each street.

A street gets the asphalt look when OpenStreetMap says it is paved, or when it is a main road
(motorway to secondary) that OpenStreetMap does not call unpaved. Lanes come from its lanes tags;
without them a street has one lane each way, a one-way carriageway one lane, and a service road
or living street one shared lane. Tunnels are left out. Shaydon's R-303 and its bridge, which the
user asked to see as asphalt, are always in.

The output is one small JSON file per zoom-10 tile a street crosses, which the map loads near
where it looks:

    {"roads": [[way id, lanes (0 shared, 1-6 each way), one-way 0/1, lon, lat, dlon, dlat, ...], ...]}
    coordinates in millionths of a degree, each after the first a step from the one before;
    a one-way street runs in its direction of travel

    python scripts/build-country-roads.py <tajikistan.osm.pbf> public/atlas-roads
"""
import collections
import json
import math
import os
import pathlib
import re
import sys

import osmium

ROOT = pathlib.Path(__file__).resolve().parents[1]
HIGHWAYS = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
            'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
            'service', 'road'}
MAIN = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link'}
PAVED = {'asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'chipseal', 'paving_stones', 'sett'}
SHARED = {'service', 'living_street'}
ZOOM = 10
SCALE = 1_000_000
counts = collections.Counter()


def count(value):
    match = re.match(r'\s*(\d+)', value or '')
    return int(match.group(1)) if match else 0


def lanes(tags, oneway):
    """Lanes each way (on a one-way street, its one way), 0 for one shared lane, at most 6."""
    total, forward, backward = count(tags.get('lanes')), count(tags.get('lanes:forward')), count(tags.get('lanes:backward'))
    if oneway:
        return min(6, total or forward or backward or 1)
    if forward or backward:
        return min(6, max(forward, backward))
    if total == 1:
        return 0
    if total:
        return min(6, (total + 1) // 2)
    return 0 if tags.get('highway') in SHARED else 1


def tile(lon, lat):
    n = 2 ** ZOOM
    sin = math.sin(math.radians(lat))
    return math.floor((lon + 180) / 360 * n), math.floor((0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * n)


class Roads(osmium.SimpleHandler):
    def __init__(self, styled):
        super().__init__()
        self.styled = styled
        self.files = collections.defaultdict(list)

    def way(self, way):
        tags = way.tags
        highway, surface = tags.get('highway'), tags.get('surface')
        if highway not in HIGHWAYS or tags.get('area') == 'yes' or tags.get('tunnel') not in (None, 'no'):
            return
        requested = way.id in self.styled
        if not (surface in PAVED or (surface is None and highway in MAIN) or requested):
            return
        try:
            line = [(node.lon, node.lat) for node in way.nodes]
        except osmium.InvalidLocationError:
            counts['broken'] += 1
            return
        if len(line) < 2:
            return
        oneway = tags.get('oneway') in ('yes', '1', 'true', '-1') or tags.get('junction') == 'roundabout'
        if tags.get('oneway') == '-1':
            line.reverse()
        each = lanes(tags, oneway)
        record, px, py = [way.id, each, 1 if oneway else 0], 0, 0
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
        counts['roads'] += 1
        counts['paved_tag' if surface in PAVED else 'main_road_assumed_paved' if surface is None and highway in MAIN else 'asphalt_on_request'] += 1
        counts['oneway' if oneway else 'two_way'] += 1
        counts[f'lanes_{each}'] += 1


def main(pbf, destination):
    destination = pathlib.Path(destination)
    style = json.loads((ROOT / 'public' / 'atlas-data' / 'shaydon-style.json').read_text(encoding='utf-8'))
    styled = {int(re.sub(r'\D', '', str(way))) for way in style.get('way_ids', [])}
    roads = Roads(styled)
    roads.apply_file(str(pbf), locations=True, idx='flex_mem')
    destination.mkdir(parents=True, exist_ok=True)
    for old in destination.glob('*.json'):
        old.unlink()
    names, total = [], 0
    for (x, y), records in sorted(roads.files.items()):
        text = json.dumps({'roads': records}, separators=(',', ':'))
        (destination / f'{x}-{y}.json').write_text(text, encoding='utf-8')
        names.append(f'{x}-{y}')
        total += len(text)
    index = {
        'tier': ZOOM, 'groups': names, 'counts': dict(counts), 'licence': 'ODbL',
        'source': 'OpenStreetMap contributors, Geofabrik extract of 12.09.2026',
        'rule': 'paved by surface tag, or motorway to secondary without a surface tag; lanes from lanes tags, else one each way',
    }
    (destination / 'index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Complete: {counts["roads"]} asphalt streets in {len(names)} files, {total / 1e6:.2f} MB. {dict(counts)}', flush=True)


if __name__ == '__main__':
    main(*sys.argv[1:3])
    sys.stdout.flush()
    os._exit(0)

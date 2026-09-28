"""Street furniture across Tajikistan from OpenStreetMap, for the 3D map: bus stops with a shelter,
traffic lights at each approach to a signal, trees and tree rows, benches, fountains, monuments
and flagpoles, and the State Emblem monument. Where they stand and how tall they are comes from the
data; the shapes are Atlas's own simple models, turned to face the nearest street.

The output is one small JSON file per zoom-10 tile, which the map loads near where it looks:

    {"things": [[kind, lon, lat, facing, size, name], ...]}
    lon and lat in millionths of a degree; facing in whole degrees from north (a shelter's open
    side, a signal's lamps, a bench's seat, a monument's front); size in decimetres (a tree's or
    monument's height, a fountain's radius), 0 when the data gives none; a name only for stops

    python scripts/build-country-things.py <tajikistan.osm.pbf> public/atlas-things
"""
import collections
import importlib.util
import json
import math
import os
import pathlib
import re
import sys

import osmium

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('country_roads', HERE / 'build-country-roads.py')
roads = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(roads)

ZOOM = 10
SCALE = 1_000_000
LANE = 3.35          # metres across a lane, as the map draws one at street zoom
CELL = 0.001         # ~100 m buckets for finding the street beside a thing
REACH = 40           # metres: further than this from a street, a thing keeps its own facing
STOP_MERGE = 30      # metres: a stop's pole, platform and shelter are one stop
TREE_SPACING = 8     # metres between trees of a tree row
MEMORIALS = {'monument', 'statue', 'bust', 'stele', 'obelisk', 'war_memorial', 'sculpture', 'stone', 'cross'}
ARTWORKS = {'statue', 'sculpture', 'bust', 'monument', 'stele', 'obelisk'}
counts = collections.Counter()


def metres(a, b):
    cos = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * cos * 111_320, (b[1] - a[1]) * 111_320)


def bearing(a, b):
    return math.degrees(math.atan2((b[0] - a[0]) * math.cos(math.radians(a[1])), b[1] - a[1])) % 360


def move(point, heading, distance):
    rad = math.radians(heading)
    return (point[0] + math.sin(rad) * distance / (111_320 * math.cos(math.radians(point[1]))),
            point[1] + math.cos(rad) * distance / 111_320)


def number(value):
    match = re.match(r'\s*(\d+(?:[.,]\d+)?)', value or '')
    return float(match.group(1).replace(',', '.')) if match else 0.0


def cell(point):
    return math.floor(point[0] / CELL), math.floor(point[1] / CELL)


def is_oneway(tags):
    return tags.get('oneway') in ('yes', '1', 'true', '-1') or tags.get('junction') == 'roundabout'


def half_width(tags, oneway):
    each = roads.lanes(tags, oneway)
    total = 0 if each == 0 else each if oneway else each * 2
    return 2.3 if total == 0 else total * LANE / 2


def platform(tags):
    return tags.get('public_transport') == 'platform' and tags.get('railway') != 'platform' and tags.get('train') != 'yes'


def classify(tags):
    if tags.get('highway') == 'bus_stop' or platform(tags) or (tags.get('amenity') == 'shelter' and tags.get('shelter_type') == 'public_transport'):
        return 'stop'
    if tags.get('highway') == 'traffic_signals':
        return 'signal'
    if tags.get('natural') == 'tree':
        return 'tree'
    if tags.get('amenity') == 'bench':
        return 'bench'
    if tags.get('amenity') == 'fountain':
        return 'fountain'
    if tags.get('man_made') == 'flagpole':
        return 'flag'
    if tags.get('historic') in ('monument', 'memorial') and ('emblem' in (tags.get('name:en') or '').lower() or 'герб' in (tags.get('name:ru') or '').lower()):
        return 'emblem'
    if tags.get('historic') == 'monument' or (tags.get('historic') == 'memorial' and tags.get('memorial', 'monument') in MEMORIALS) \
            or (tags.get('tourism') == 'artwork' and tags.get('artwork_type') in ARTWORKS):
        return 'monument'
    return None


class Places(osmium.SimpleHandler):
    """First pass: the things themselves, from nodes and from tree rows, fountains and platforms drawn as ways."""

    def __init__(self):
        super().__init__()
        self.things = []    # [kind, (lon, lat), tags, node id or None]

    def node(self, node):
        kind = classify(node.tags) if node.tags else None
        if kind:
            self.things.append([kind, (node.location.lon, node.location.lat), dict(node.tags), node.id])
            counts[f'osm_{kind}'] += 1

    def way(self, way):
        tags = way.tags
        row, fountain, stop = tags.get('natural') == 'tree_row', tags.get('amenity') == 'fountain', platform(tags)
        if not (row or fountain or stop):
            return
        try:
            line = [(node.lon, node.lat) for node in way.nodes]
        except osmium.InvalidLocationError:
            return
        if len(line) < 2:
            return
        if row:
            carry = 0.0
            for a, b in zip(line, line[1:]):
                length, along = metres(a, b), carry
                while length and along < length:
                    t = along / length
                    self.things.append(['tree', (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), dict(tags), None])
                    along += TREE_SPACING
                carry = along - length
            counts['osm_tree_row'] += 1
            return
        ring = line[:-1] if line[0] == line[-1] else line
        middle = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
        own = dict(tags)
        if fountain and len(ring) >= 3:
            cos = math.cos(math.radians(middle[1]))
            area = abs(sum((p[0] - middle[0]) * (q[1] - middle[1]) - (q[0] - middle[0]) * (p[1] - middle[1])
                           for p, q in zip(ring, ring[1:] + ring[:1]))) / 2 * cos * 111_320 ** 2
            own['atlas:radius'] = str(math.sqrt(area / math.pi))
        self.things.append(['fountain' if fountain else 'stop', middle, own, None])
        counts[f'osm_{"fountain" if fountain else "stop"}_way'] += 1


class Streets(osmium.SimpleHandler):
    """Second pass: street pieces near the things that turn to a street, and each signal's approaches."""

    def __init__(self, near, signals):
        super().__init__()
        self.near, self.signals = near, signals
        self.segments = collections.defaultdict(list)
        self.approaches = collections.defaultdict(list)

    def way(self, way):
        tags = way.tags
        if tags.get('highway') not in roads.HIGHWAYS or tags.get('area') == 'yes':
            return
        try:
            nodes = [(node.ref, (node.lon, node.lat)) for node in way.nodes]
        except osmium.InvalidLocationError:
            return
        oneway = is_oneway(tags)
        if tags.get('oneway') == '-1':
            nodes.reverse()
        half = half_width(tags, oneway)
        for i, (ref, _) in enumerate(nodes):
            if ref not in self.signals:
                continue
            if i > 0:
                self.approaches[ref].append((nodes[i - 1][1], half))
            if i + 1 < len(nodes) and not oneway:
                self.approaches[ref].append((nodes[i + 1][1], half))
        for (_, a), (_, b) in zip(nodes, nodes[1:]):
            steps = max(1, math.ceil(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / (CELL / 2)))
            for key in {cell((a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps)) for k in range(steps + 1)}:
                if key in self.near:
                    self.segments[key].append((a, b, half))


def nearest(segments, point):
    """The closest street piece within reach: (distance, foot on the street, street bearing, half width)."""
    best = None
    x, y = cell(point)
    for key in ((x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
        for a, b, half in segments.get(key, ()):
            cos = math.cos(math.radians(point[1]))
            ax, ay = (a[0] - point[0]) * cos * 111_320, (a[1] - point[1]) * 111_320
            dx, dy = (b[0] - a[0]) * cos * 111_320, (b[1] - a[1]) * 111_320
            length = dx * dx + dy * dy
            if not length:
                continue
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / length))
            gap = math.hypot(ax + dx * t, ay + dy * t)
            if gap <= REACH and (best is None or gap < best[0]):
                best = (gap, (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), bearing(a, b), half)
    return best


def main(pbf, destination):
    places = Places()
    places.apply_file(str(pbf), locations=True, idx='flex_mem')
    near = {(cx + dx, cy + dy) for kind, point, _, _ in places.things if kind in ('stop', 'bench', 'monument', 'signal')
            for cx, cy in [cell(point)] for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
    signals = {node for kind, _, _, node in places.things if kind == 'signal' and node}
    streets = Streets(near, signals)
    streets.apply_file(str(pbf), locations=True, idx='flex_mem')

    # A stop's pole, its platform and its shelter become one stop.
    stops, merged = [], collections.defaultdict(list)
    for kind, point, tags, node in places.things:
        if kind != 'stop':
            continue
        key = cell(point)
        match = next((stop for dx in (-1, 0, 1) for dy in (-1, 0, 1) for stop in merged[(key[0] + dx, key[1] + dy)]
                      if metres(stop[0], point) < STOP_MERGE), None)
        name = tags.get('name:ru') or tags.get('name') or ''
        if match:
            match[1] = match[1] or name
            counts['stop_merged'] += 1
        else:
            stop = [point, name]
            stops.append(stop)
            merged[key].append(stop)

    out = []

    def put(kind, point, facing=0.0, size=0.0, name=''):
        out.append([kind, point, round(facing) % 360, max(0, min(4000, round(size * 10))), name])
        counts[kind] += 1

    for point, name in stops:
        street = nearest(streets.segments, point)
        if not street:
            put('stop', point, 0, 0, name)
            continue
        gap, foot, heading, half = street
        if gap < half + 0.5:
            # Mapped on the carriageway: stand on the right-hand kerb, open towards the street.
            put('stop', move(foot, heading + 90, half + 2), heading - 90, 0, name)
        else:
            put('stop', point, bearing(point, foot), 0, name)
    for kind, point, tags, node in places.things:
        if kind == 'stop':
            continue
        direction = number(tags.get('direction')) if re.fullmatch(r'\s*\d+(\.\d+)?\s*', tags.get('direction') or '') else None
        if kind == 'signal':
            approaches = streets.approaches.get(node, [])[:4]
            for start, half in approaches:
                travel = bearing(start, point)
                # Before the stop line on the right-hand kerb, lamps towards oncoming drivers.
                put('signal', move(move(point, travel + 180, 4), travel + 90, half + 1), travel + 180)
            if not approaches:
                put('signal', point)
        elif kind == 'tree':
            put('tree', point, 0, number(tags.get('height')))
        elif kind == 'fountain':
            radius = number(tags.get('atlas:radius')) or number(tags.get('diameter')) / 2
            put('fountain', point, 0, min(radius, 30))
        elif kind == 'flag':
            put('flag', point, 90, number(tags.get('height')))
        else:
            street = nearest(streets.segments, point) if direction is None else None
            facing = direction if direction is not None else bearing(point, street[1]) if street and street[0] > 0.5 else 0
            put(kind, point, facing, number(tags.get('height')) if kind == 'monument' else 0)

    files = collections.defaultdict(list)
    for kind, (lon, lat), facing, size, name in out:
        x, y = round(lon * SCALE), round(lat * SCALE)
        # File by the stored, rounded position, so a reader finds a thing in the tile it computes.
        lon, lat = x / SCALE, y / SCALE
        n, sin = 2 ** ZOOM, math.sin(math.radians(lat))
        key = (math.floor((lon + 180) / 360 * n), math.floor((0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * n))
        record = [kind, x, y, facing, size]
        if name:
            record.append(name)
        files[key].append(record)
    destination = pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for old in destination.glob('*.json'):
        old.unlink()
    names, total = [], 0
    for (x, y), records in sorted(files.items()):
        text = json.dumps({'things': records}, ensure_ascii=False, separators=(',', ':'))
        (destination / f'{x}-{y}.json').write_text(text, encoding='utf-8')
        names.append(f'{x}-{y}')
        total += len(text.encode('utf-8'))
    index = {'tier': ZOOM, 'groups': names, 'counts': dict(counts), 'licence': 'ODbL',
             'source': 'OpenStreetMap contributors, Geofabrik extract of 12.09.2026'}
    (destination / 'index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Complete: {len(out)} things in {len(names)} files, {total / 1e6:.2f} MB. {dict(counts)}', flush=True)


if __name__ == '__main__':
    main(*sys.argv[1:3])
    sys.stdout.flush()
    os._exit(0)

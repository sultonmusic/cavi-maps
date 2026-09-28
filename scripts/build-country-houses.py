"""Houses for the whole of Tajikistan in 3D: OpenStreetMap building outlines, and Microsoft's
Global ML Building Footprints wherever OpenStreetMap has no building. Both are ODbL. Nothing here
invents geometry: outlines are only simplified, and a wall height is kept only when a source
states one.

Shaydon is left out: it has its own numbered footprints whose floors the admin edits.

The output is one small binary file per 2 x 2 zoom-13 tiles, which the browser cuts into vector
tiles; lib/country-houses.mjs describes the format and reads it.

    python scripts/build-country-houses.py <tajikistan.osm.pbf> <microsoft shard dir> public/atlas-houses
"""
import array
import collections
import gzip
import importlib.util
import json
import math
import os
import pathlib
import struct
import sys

import osmium

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('shaydon_buildings', HERE / 'extract-shaydon-buildings.py')
shaydon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shaydon)

UNIT = 2 ** 28          # file units across the world
GROUP_BITS = 16         # a file spans 2 x 2 zoom-13 tiles, 2^16 units
CELL_BITS = 10          # about 120 m buckets for matching Microsoft footprints to OSM outlines
MAX_CORNERS = 255
SKIPPED = {'no', 'roof'}  # a canopy on posts is not a solid block
counts = collections.Counter()


def project(lon, lat):
    sin = math.sin(math.radians(lat))
    return (round((lon + 180) / 360 * UNIT),
            round((0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * UNIT))


def unproject(x, y):
    return x / UNIT * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / UNIT))))


def in_shaydon(points):
    """Whether a house's middle, exactly as the files store it, lies in Shaydon's box."""
    west, south, east, north = shaydon.BOUNDS
    lon, lat = unproject(*centre(points))
    return west < lon < east and south < lat < north


def number(value):
    try:
        return float(value.lower().replace('m', '').replace(',', '.').strip())
    except (AttributeError, ValueError):
        return 0.0


def stated_height(tags):
    """Metres from an OpenStreetMap height, or floors at 3 m plus a metre as the map counts them."""
    metres = number(tags.get('height'))
    if 1 <= metres <= 500:
        return min(255, round(metres))
    levels = number(tags.get('building:levels'))
    if 1 <= levels <= 60:
        return min(255, round(levels) * 3 + 1)
    return 0


def outline(ring):
    """Simplify a lon/lat outline and snap it to file units, clockwise on screen as vector tiles
    expect; None when it is too small to be a house or collapses."""
    if len(ring) > 1 and ring[0] == ring[-1]:
        ring = ring[:-1]
    if len(ring) < 3:
        return None
    lat = sum(p[1] for p in ring) / len(ring)
    tolerance = shaydon.TOLERANCE_METRES / 111_320.0
    simple = shaydon.simplify(ring, tolerance)
    while len(simple) > MAX_CORNERS:
        tolerance *= 2
        simple = shaydon.simplify(ring, tolerance)
    if len(simple) < 3 or shaydon.ring_area_sqm(simple, lat) < shaydon.MIN_AREA_SQM:
        return None
    points = []
    for lon, lat in simple:
        point = project(lon, lat)
        if not points or point != points[-1]:
            points.append(point)
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    if len(points) < 3:
        return None
    twice = sum(ax * by - bx * ay for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1]))
    if twice == 0:
        return None
    if twice < 0:
        points.reverse()
    return points


def centre(points):
    return sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points)


def inside(point, ring):
    x, y = point
    hit, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


class Files:
    """House records by file, in the format lib/country-houses.mjs reads."""

    def __init__(self):
        self.groups = {}

    def add(self, points, height):
        cx, cy = centre(points)
        gx, gy = math.floor(cx) >> GROUP_BITS, math.floor(cy) >> GROUP_BITS
        steps = []
        for (ax, ay), (bx, by) in zip(points, points[1:]):
            dx, dy = bx - ax, by - ay
            if not (-32768 <= dx <= 32767 and -32768 <= dy <= 32767):
                counts['too_large'] += 1
                return False
            steps += (dx, dy)
        record = struct.pack(f'<BBii{len(steps)}h', len(points), height,
                             points[0][0] - (gx << GROUP_BITS), points[0][1] - (gy << GROUP_BITS), *steps)
        group = self.groups.get((gx, gy))
        if group is None:
            group = self.groups[(gx, gy)] = [0, bytearray()]
        group[0] += 1
        group[1] += record
        return True


class Outlines:
    """OpenStreetMap outlines in ~120 m buckets, compact enough for a country on a small machine."""

    def __init__(self):
        self.coords = array.array('i')
        self.starts = array.array('I', [0])
        self.boxes = array.array('i')
        self.centres = array.array('d')
        self.cells = {}

    def add(self, points):
        index = len(self.starts) - 1
        for x, y in points:
            self.coords.append(x)
            self.coords.append(y)
        self.starts.append(len(self.coords))
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        box = (min(xs), min(ys), max(xs), max(ys))
        self.boxes.extend(box)
        self.centres.extend(centre(points))
        for kx in range(box[0] >> CELL_BITS, (box[2] >> CELL_BITS) + 1):
            for ky in range(box[1] >> CELL_BITS, (box[3] >> CELL_BITS) + 1):
                self.cells.setdefault(kx << 20 | ky, []).append(index)

    def repeats(self, points):
        """True when a footprint's middle is inside an OSM outline, or an OSM outline's middle is inside it."""
        middle = centre(points)
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        seen = set()
        for kx in range(x0 >> CELL_BITS, (x1 >> CELL_BITS) + 1):
            for ky in range(y0 >> CELL_BITS, (y1 >> CELL_BITS) + 1):
                for index in self.cells.get(kx << 20 | ky, ()):
                    if index in seen:
                        continue
                    seen.add(index)
                    b = 4 * index
                    if self.boxes[b] > x1 or self.boxes[b + 2] < x0 or self.boxes[b + 1] > y1 or self.boxes[b + 3] < y0:
                        continue
                    flat = self.coords[self.starts[index]:self.starts[index + 1]]
                    ring = list(zip(flat[0::2], flat[1::2]))
                    if inside(middle, ring) or inside((self.centres[2 * index], self.centres[2 * index + 1]), points):
                        return True
        return False


class OsmHouses(osmium.SimpleHandler):
    def __init__(self, files, outlines):
        super().__init__()
        self.files, self.outlines = files, outlines

    def area(self, area):
        tags = area.tags
        kind = tags.get('building')
        if not kind or kind in SKIPPED or tags.get('location') == 'underground':
            return
        height = stated_height(tags)
        for outer in area.outer_rings():
            try:
                ring = [(node.lon, node.lat) for node in outer]
            except osmium.InvalidLocationError:
                counts['osm_broken'] += 1
                continue
            if len(ring) < 4:
                continue
            points = outline(ring)
            if not points:
                counts['osm_small'] += 1
            elif in_shaydon(points):
                counts['osm_in_shaydon'] += 1
            elif self.files.add(points, height):
                self.outlines.add(points)
                counts['osm'] += 1
                if height:
                    counts['osm_with_height'] += 1
                if counts['osm'] % 100_000 == 0:
                    print('OpenStreetMap houses:', counts['osm'], flush=True)


def microsoft(directory, files, outlines):
    for shard in sorted(pathlib.Path(directory).glob('*.csv.gz')):
        with gzip.open(shard, 'rt', encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    feature = json.loads(line)
                    geometry = feature['geometry']
                    if geometry['type'] != 'Polygon':
                        continue
                    ring = [(float(p[0]), float(p[1])) for p in geometry['coordinates'][0]]
                except (ValueError, KeyError, IndexError, TypeError):
                    continue
                counts['microsoft_read'] += 1
                if len(ring) < 4:
                    continue
                points = outline(ring)
                if not points:
                    counts['microsoft_small'] += 1
                    continue
                if in_shaydon(points):
                    counts['microsoft_in_shaydon'] += 1
                    continue
                if outlines.repeats(points):
                    counts['microsoft_in_osm'] += 1
                    continue
                stated = (feature.get('properties') or {}).get('height', -1)
                height = min(255, round(stated)) if isinstance(stated, (int, float)) and stated >= 1 else 0
                if files.add(points, height):
                    counts['microsoft'] += 1
                    if counts['microsoft'] % 200_000 == 0:
                        print('Microsoft footprints added:', counts['microsoft'], flush=True)
        print('Read', shard.name, dict(counts), flush=True)


def main(pbf, shards, destination):
    destination = pathlib.Path(destination)
    files, outlines = Files(), Outlines()
    print('Reading OpenStreetMap buildings...', flush=True)
    OsmHouses(files, outlines).apply_file(str(pbf), locations=True, idx='flex_mem')
    print('Matching Microsoft footprints...', flush=True)
    microsoft(shards, files, outlines)
    destination.mkdir(parents=True, exist_ok=True)
    for old in destination.glob('*.bin'):
        old.unlink()
    names, largest = [], 0
    for (gx, gy), (count, records) in sorted(files.groups.items()):
        name = f'{gx}-{gy}'
        (destination / f'{name}.bin').write_bytes(b'AHB1' + struct.pack('<I', count) + bytes(records))
        names.append(name)
        largest = max(largest, 8 + len(records))
    total = sum(8 + len(records) for _, records in files.groups.values())
    index = {
        'format': 'AHB1', 'unit': UNIT, 'tier': 13, 'group': 2, 'groups': names,
        'counts': dict(counts),
        'sources': [
            'OpenStreetMap contributors, Geofabrik extract of 12.09.2026',
            'Microsoft Global ML Building Footprints, release of 03.02.2026',
        ],
        'licence': 'ODbL',
    }
    (destination / 'index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Complete: {counts["osm"]} OSM houses ({counts["osm_with_height"]} with a stated height), '
          f'{counts["microsoft"]} Microsoft footprints, {len(names)} files, {total / 1e6:.1f} MB, '
          f'largest {largest / 1e6:.2f} MB. {dict(counts)}', flush=True)


if __name__ == '__main__':
    main(*sys.argv[1:4])
    # Everything is written; skip tearing down millions of Python objects.
    os._exit(0)

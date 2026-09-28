"""Add Shaydon houses from a newer release of Microsoft's Global ML Building Footprints (ODbL) to
public/shaydon-buildings.json, without disturbing the houses already there.

A footprint counts as already mapped when its middle lies inside a shipped footprint, or a shipped
footprint's middle lies inside it. New footprints are simplified and filtered exactly as
extract-shaydon-buildings.py does, and a footprint whose middle sits on a carriageway is dropped as
a false detection, with the same clearances scripts/check-shaydon.mjs holds the map to. The rest are
appended: every existing house keeps its index, so the floors and roofs the admin stored under
`ms:<index>` and the house numbers stay attached to the same houses. Appended houses have no number,
street or height.

    python scripts/add-shaydon-buildings.py <microsoft shard dir>
"""
import gzip
import importlib.util
import json
import math
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('shaydon_buildings', HERE / 'extract-shaydon-buildings.py')
shaydon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shaydon)

TARGET = HERE.parent / 'public' / 'shaydon-buildings.json'
STREETS = HERE.parent / 'public' / 'streets.json'
CELL = 0.0005
CARRIAGEWAY = {'secondary': 7, 'tertiary': 6, 'primary': 8, 'trunk': 9}
CARRIAGEWAY_DEFAULT = 3.5


def carriageways():
    """Street pieces around Shaydon with the clearance a house's middle must keep from them."""
    pieces = []
    for road in json.loads(STREETS.read_text(encoding='utf-8'))['roads']:
        box = road.get('bbox')
        if not box or box[2] < 70.31 or box[0] > 70.41 or box[3] < 40.62 or box[1] > 40.70:
            continue
        clearance = CARRIAGEWAY.get((road.get('tags') or {}).get('highway'), CARRIAGEWAY_DEFAULT)
        line = road['coordinates']
        pieces += [(line[i - 1], line[i], clearance) for i in range(1, len(line))]
    return pieces


def on_carriageway(point, pieces):
    lon, lat = point
    cos = math.cos(40.66 * math.pi / 180)
    for start, end, clearance in pieces:
        if abs(start[1] - lat) > 0.001 and abs(end[1] - lat) > 0.001:
            continue
        px, py = (lon - start[0]) * cos, lat - start[1]
        dx, dy = (end[0] - start[0]) * cos, end[1] - start[1]
        length = dx * dx + dy * dy
        t = max(0.0, min(1.0, (px * dx + py * dy) / length)) if length else 0.0
        # A little extra room, so a house on the edge is not let through by rounding.
        if math.hypot(px - dx * t, py - dy * t) * 111_320 < clearance + 0.3:
            return True
    return False


def quadkey(lon, lat, zoom=9):
    n, sin = 2 ** zoom, math.sin(math.radians(lat))
    x, y = int((lon + 180) / 360 * n), int((0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * n)
    return ''.join(str(((x >> (zoom - 1 - i)) & 1) + 2 * ((y >> (zoom - 1 - i)) & 1)) for i in range(zoom))


def centre(ring):
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


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


def main(shards):
    data = json.loads(TARGET.read_text(encoding='utf-8'))
    origin_lon, origin_lat = data['origin']
    scale = data['scale']
    existing = []
    for flat in data['buildings']:
        x = y = 0
        ring = []
        for i in range(0, len(flat), 2):
            x += flat[i]
            y += flat[i + 1]
            ring.append((origin_lon + x / scale, origin_lat + y / scale))
        existing.append(ring)
    grid = {}
    for index, ring in enumerate(existing):
        for cx in range(math.floor(min(p[0] for p in ring) / CELL), math.floor(max(p[0] for p in ring) / CELL) + 1):
            for cy in range(math.floor(min(p[1] for p in ring) / CELL), math.floor(max(p[1] for p in ring) / CELL) + 1):
                grid.setdefault((cx, cy), []).append(index)

    west, south, east, north = shaydon.BOUNDS
    keys = sorted({quadkey(lon, lat) for lon in (west, east) for lat in (south, north)})
    added, same, small, on_road = [], 0, 0, 0
    tolerance = shaydon.TOLERANCE_METRES / 111_320.0
    pieces = carriageways()
    for key in keys:
        with gzip.open(pathlib.Path(shards) / f'{key}.csv.gz', 'rt', encoding='utf-8') as handle:
            for line in handle:
                try:
                    feature = json.loads(line)
                    ring = feature['geometry']['coordinates'][0]
                except (ValueError, KeyError, IndexError, TypeError):
                    continue
                if ring[0] == ring[-1]:
                    ring = ring[:-1]
                if len(ring) < 3:
                    continue
                middle = centre(ring)
                if not (west < middle[0] < east and south < middle[1] < north):
                    continue
                gx, gy = math.floor(middle[0] / CELL), math.floor(middle[1] / CELL)
                near = {i for dx in (-1, 0, 1) for dy in (-1, 0, 1) for i in grid.get((gx + dx, gy + dy), [])}
                if any(inside(middle, existing[i]) or inside(centre(existing[i]), ring) for i in near):
                    same += 1
                    continue
                simple = shaydon.simplify(ring, tolerance)
                if len(simple) < 3 or shaydon.ring_area_sqm(simple, middle[1]) < shaydon.MIN_AREA_SQM:
                    small += 1
                    continue
                # Judged by the middle of the outline as it will be stored, to the file's precision.
                stored = [(origin_lon + round((lon - origin_lon) * scale) / scale, origin_lat + round((lat - origin_lat) * scale) / scale) for lon, lat in simple]
                if on_carriageway(centre(stored), pieces):
                    on_road += 1
                    continue
                added.append(simple)

    for ring in added:
        flat, previous_x, previous_y = [], 0, 0
        for lon, lat in ring:
            x, y = round((lon - origin_lon) * scale), round((lat - origin_lat) * scale)
            flat += (x - previous_x, y - previous_y)
            previous_x, previous_y = x, y
        data['buildings'].append(flat)
        # No surveyed heights exist, so none is published.
        data['heights'].append(0)
        if 'number' in data:
            data['number'].append(0)
        if 'street' in data:
            data['street'].append(-1)
    data['additions'] = data.get('additions', []) + [{'release': 'Microsoft Global ML Building Footprints 2026-02-03', 'houses': len(added)}]
    TARGET.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(json.dumps({'shards': keys, 'before': len(existing), 'added': len(added), 'already_mapped': same, 'too_small': small, 'on_carriageway': on_road, 'after': len(data['buildings'])}), flush=True)


if __name__ == '__main__':
    main(sys.argv[1])

"""Extract real Shaydon building footprints from Microsoft's Global ML Building
Footprints (ODbL) into the compact form the Atlas renderer reads.

Input is one quadkey shard of the published `global-buildings.geojsonl` set.
Nothing here invents geometry: polygons are only simplified, never synthesised.

    python scripts/extract-shaydon-buildings.py <shard.csv.gz> public/shaydon-buildings.json
"""
import gzip
import json
import math
import sys

# Shaydon and a margin around it, matching the four proposed microdistricts.
BOUNDS = (70.318, 40.628, 70.402, 40.692)
SCALE = 1_000_000          # 1e-6 degrees, about 11 cm
TOLERANCE_METRES = 0.25
MIN_AREA_SQM = 6.0


def perpendicular(point, start, end):
    x, y = point
    x0, y0 = start
    x1, y1 = end
    dx, dy = x1 - x0, y1 - y0
    if dx == 0 and dy == 0:
        return math.hypot(x - x0, y - y0)
    t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))


def simplify(points, tolerance):
    """Douglas-Peucker, iterative so a long traced outline cannot blow the stack."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        worst, index = tolerance, -1
        for i in range(first + 1, last):
            gap = perpendicular(points[i], points[first], points[last])
            if gap > worst:
                worst, index = gap, i
        if index != -1:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))
    return [point for point, kept in zip(points, keep) if kept]


def ring_area_sqm(ring, lat):
    metres_per_degree = 111_320.0
    cos = math.cos(math.radians(lat))
    total = 0.0
    for i in range(len(ring)):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % len(ring)]
        total += (x0 * cos) * y1 - (x1 * cos) * y0
    return abs(total) * 0.5 * metres_per_degree ** 2


def main(source, destination):
    west, south, east, north = BOUNDS
    kept = []
    read = skipped_small = 0
    with gzip.open(source, 'rt', encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            read += 1
            try:
                feature = json.loads(line)
                ring = feature['geometry']['coordinates'][0]
            except (ValueError, KeyError, IndexError):
                continue
            if ring[0] == ring[-1]:
                ring = ring[:-1]
            if len(ring) < 3:
                continue
            lon = sum(p[0] for p in ring) / len(ring)
            lat = sum(p[1] for p in ring) / len(ring)
            if not (west < lon < east and south < lat < north):
                continue
            # Work the tolerance in degrees at this latitude.
            degrees = TOLERANCE_METRES / 111_320.0
            simple = simplify(ring, degrees)
            if len(simple) < 3:
                continue
            if ring_area_sqm(simple, lat) < MIN_AREA_SQM:
                skipped_small += 1
                continue
            height = feature.get('properties', {}).get('height', -1)
            kept.append((simple, height if isinstance(height, (int, float)) and height > 0 else None))

    origin_lon = min(min(p[0] for p in ring) for ring, _ in kept)
    origin_lat = min(min(p[1] for p in ring) for ring, _ in kept)
    buildings, heights = [], []
    for ring, height in kept:
        flat, previous_x, previous_y = [], 0, 0
        for lon, lat in ring:
            x = round((lon - origin_lon) * SCALE)
            y = round((lat - origin_lat) * SCALE)
            flat.append(x - previous_x)
            flat.append(y - previous_y)
            previous_x, previous_y = x, y
        buildings.append(flat)
        heights.append(round(height, 1) if height else 0)

    payload = {
        'source': 'Microsoft Global ML Building Footprints',
        'licence': 'ODbL',
        'area': 'Шайдон',
        'origin': [origin_lon, origin_lat],
        'scale': SCALE,
        'buildings': buildings,
        'heights': heights,
    }
    with open(destination, 'w', encoding='utf-8') as out:
        json.dump(payload, out, separators=(',', ':'))
    vertices = sum(len(f) // 2 for f in buildings)
    print(f'read {read} features, kept {len(kept)} in Shaydon '
          f'({vertices} vertices, {skipped_small} below {MIN_AREA_SQM} m2)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])

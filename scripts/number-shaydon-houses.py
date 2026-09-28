"""Clean up the Shaydon footprints and give each one a street and a house number.

Two passes over the same road geometry:

1. A footprint whose centre sits on the carriageway is machine-vision noise —
   a wall, a kerb, a parked lorry — so it is dropped.
2. Every surviving footprint is attached to the nearest named street, and the
   houses on that street are numbered 1..n from its northern end, matching the
   order the street names themselves use.

    python scripts/number-shaydon-houses.py
"""
import json
import math

BUILDINGS = 'public/shaydon-buildings.json'
STREETS = 'public/streets.json'
SCALE = 1_000_000
MAX_STREET_M = 70.0
CELL = 0.0015                      # roughly 130 m, the search grid step
METRES_PER_DEGREE = 111_320.0
# Half-widths of the carriageway itself, by road class.
CARRIAGEWAY = {'secondary': 7.0, 'tertiary': 6.0, 'primary': 8.0, 'trunk': 9.0}
CARRIAGEWAY_DEFAULT = 3.5


def load_roads(bounds):
    west, south, east, north = bounds
    roads = []
    with open(STREETS, encoding='utf-8') as handle:
        for road in json.load(handle)['roads']:
            points = road.get('coordinates')
            if not isinstance(points, list) or len(points) < 2:
                continue
            box = road.get('bbox')
            if box and (box[2] < west or box[0] > east or box[3] < south or box[1] > north):
                continue
            highway = (road.get('tags') or {}).get('highway', '')
            roads.append({
                'id': road.get('groupId') or road['id'],
                'name': road.get('name') or road.get('ref'),
                'points': points,
                'clearance': CARRIAGEWAY.get(highway, CARRIAGEWAY_DEFAULT),
            })
    return roads


def index(roads):
    """Index every segment into a lon/lat grid so the nearest lookup stays local."""
    grid, store = {}, []
    for road in roads:
        points = road['points']
        for i in range(1, len(points)):
            slot = len(store)
            store.append((road, points[i - 1], points[i]))
            x0, y0 = points[i - 1]
            x1, y1 = points[i]
            for cx in range(int(min(x0, x1) / CELL), int(max(x0, x1) / CELL) + 1):
                for cy in range(int(min(y0, y1) / CELL), int(max(y0, y1) / CELL) + 1):
                    grid.setdefault((cx, cy), []).append(slot)
    return grid, store


def project(point, start, end, cos_lat):
    """Distance in metres from a point to a segment, and how far along it lands."""
    px, py = (point[0] - start[0]) * cos_lat, point[1] - start[1]
    dx, dy = (end[0] - start[0]) * cos_lat, end[1] - start[1]
    length = dx * dx + dy * dy
    t = 0.0 if not length else max(0.0, min(1.0, (px * dx + py * dy) / length))
    return math.hypot(px - dx * t, py - dy * t) * METRES_PER_DEGREE, t


def decode(data):
    origin_lon, origin_lat = data['origin']
    scale = data['scale']
    shapes = []
    for flat in data['buildings']:
        ring, x, y = [], 0, 0
        for i in range(0, len(flat), 2):
            x += flat[i]
            y += flat[i + 1]
            ring.append((origin_lon + x / scale, origin_lat + y / scale))
        shapes.append(ring)
    return shapes


def encode(rings):
    origin_lon = min(min(p[0] for p in ring) for ring in rings)
    origin_lat = min(min(p[1] for p in ring) for ring in rings)
    out = []
    for ring in rings:
        flat, previous_x, previous_y = [], 0, 0
        for lon, lat in ring:
            x = round((lon - origin_lon) * SCALE)
            y = round((lat - origin_lat) * SCALE)
            flat.append(x - previous_x)
            flat.append(y - previous_y)
            previous_x, previous_y = x, y
        out.append(flat)
    return [origin_lon, origin_lat], out


def main():
    data = json.load(open(BUILDINGS, encoding='utf-8'))
    rings = decode(data)
    heights = data.get('heights') or [0] * len(rings)
    centres = [(sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)) for ring in rings]

    west = min(c[0] for c in centres) - 0.004
    east = max(c[0] for c in centres) + 0.004
    south = min(c[1] for c in centres) - 0.004
    north = max(c[1] for c in centres) + 0.004
    cos_lat = math.cos(math.radians((south + north) / 2))

    roads = load_roads((west, south, east, north))
    grid, store = index(roads)
    print(f'{len(roads)} streets near Shaydon, {len(store)} segments')

    kept, assigned = [], []
    on_road = 0
    for position, centre in enumerate(centres):
        cx, cy = int(centre[0] / CELL), int(centre[1] / CELL)
        best, blocked = None, False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for slot in grid.get((cx + dx, cy + dy), ()):
                    road, start, end = store[slot]
                    gap, t = project(centre, start, end, cos_lat)
                    if gap < road['clearance']:
                        blocked = True
                    if not road['name'] or gap > MAX_STREET_M:
                        continue
                    # Order along the street: northern end first, as the names run.
                    along = -(start[1] + (end[1] - start[1]) * t)
                    if best is None or gap < best[0]:
                        best = (gap, road['id'], road['name'], along)
        if blocked:
            on_road += 1
            continue
        kept.append(position)
        assigned.append(best)

    grouped = {}
    for order, best in enumerate(assigned):
        if best:
            grouped.setdefault((best[1], best[2]), []).append((best[3], order))

    names, numbers, street_of = [], [0] * len(kept), [-1] * len(kept)
    for (_, name), members in sorted(grouped.items(), key=lambda item: item[0][1]):
        slot = len(names)
        names.append(name)
        for house, (_, order) in enumerate(sorted(members), start=1):
            numbers[order] = house
            street_of[order] = slot

    origin, encoded = encode([rings[position] for position in kept])
    data.update({
        'origin': origin,
        'scale': SCALE,
        'buildings': encoded,
        'heights': [heights[position] for position in kept],
        'streets': names,
        'street': street_of,
        'number': numbers,
    })
    with open(BUILDINGS, 'w', encoding='utf-8') as out:
        json.dump(data, out, separators=(',', ':'))

    print(f'dropped {on_road} footprints sitting on a carriageway')
    print(f'{sum(1 for n in numbers if n)} of {len(kept)} houses numbered across {len(names)} streets')


if __name__ == '__main__':
    main()

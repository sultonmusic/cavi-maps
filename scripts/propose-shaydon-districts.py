"""Create explicitly proposed Shaydon zones clipped to existing urban geometry.

The output is a local Atlas design proposal, not administrative boundaries or
government-issued names. It never edits the underlying street or atlas data.
"""
from pathlib import Path
import json
import math
import sys

from shapely.geometry import Polygon, Point, box, mapping, shape
from shapely.ops import transform, unary_union


ROOT = Path(__file__).resolve().parents[1]
ATLAS = ROOT / 'public' / 'atlas-data'
BOUNDS = [70.335, 40.638, 70.386, 40.680]
TOWN_CENTER = [70.3597068, 40.6601966]
ZOOM = 13
EXTENT = 4096
NAMES = ['1 микрорайон', '2 микрорайон', '3 микрорайон', '4 микрорайон']


def world(lon, lat):
    return ((lon + 180) / 360, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2)


def geographic(x, y):
    return (x * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y)))))


def polygons(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == 'Polygon':
        return [geometry]
    return [poly for part in getattr(geometry, 'geoms', []) for poly in polygons(part)]


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    n = 2 ** ZOOM
    west, south, east, north = BOUNDS
    x0, y1 = world(west, south)
    x1, y0 = world(east, north)
    bundles, pieces, source_tiles, seen = {}, [], [], set()
    clip = box(x0, y0, x1, y1)
    for x in range(math.floor(x0 * n), math.floor(x1 * n) + 1):
        for y in range(math.floor(y0 * n), math.floor(y1 * n) + 1):
            filename = f'bundle-{ZOOM}-{x // 4}-{y // 4}.json'
            if filename not in bundles:
                path = ATLAS / filename
                bundles[filename] = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
            tile_name = f'{ZOOM}-{x}-{y}.json'
            tile_pieces = 0
            for feature in bundles[filename].get(tile_name, []):
                if feature[0] != 'urban' or not feature[1]:
                    continue
                rings = [[((x + px / EXTENT) / n, (y + py / EXTENT) / n) for px, py in ring] for ring in feature[2]]
                if not rings or len(rings[0]) < 4:
                    continue
                geometry = Polygon(rings[0], rings[1:])
                if not geometry.is_valid:
                    geometry = geometry.buffer(0)
                geometry = geometry.intersection(clip).intersection(box(x / n, y / n, (x + 1) / n, (y + 1) / n))
                for poly in polygons(geometry):
                    signature = poly.normalize().wkb
                    if signature in seen:
                        continue
                    seen.add(signature)
                    pieces.append(poly)
                    tile_pieces += 1
            if tile_pieces:
                source_tiles.append(tile_name)
    if not pieces:
        raise SystemExit('No urban footprint found; no proposed districts were created.')
    footprint = unary_union(pieces)
    town_point = Point(world(*TOWN_CENTER))
    components = polygons(footprint)
    containing = [poly for poly in components if poly.buffer(1e-10).contains(town_point)]
    if containing:
        footprint = max(containing, key=lambda poly: poly.area)
    else:
        footprint = min(components, key=lambda poly: (poly.distance(town_point), -poly.area))
        if footprint.distance(town_point) > 0.001 / 360:
            raise SystemExit('No urban footprint sufficiently close to the town center; stopped without inventing a contour.')
    # Native world y increases southward. Rotating axes by 45 degrees creates
    # four northwestern-to-southeastern bands across the actual built-up area.
    cx, cy = world(*TOWN_CENTER)
    scale = math.sqrt(2)
    def diagonal(x, y, z=None):
        return ((x - cx + y - cy) / scale, (y - cy - x + cx) / scale)
    def inverse(u, v, z=None):
        return (cx + (u - v) / scale, cy + (u + v) / scale)
    rotated = transform(diagonal, footprint)
    u0, v0, u1, v1 = rotated.bounds
    districts = []
    for index, name in enumerate(NAMES):
        left = u0 + (u1 - u0) * index / 4
        right = u0 + (u1 - u0) * (index + 1) / 4
        band = rotated.intersection(box(left, v0 - 1, right, v1 + 1))
        region = unary_union(polygons(transform(inverse, band)))
        if region.is_empty:
            raise SystemExit('An empty band was found; no proposed districts were written.')
        geo = transform(geographic, region)
        representative = geo.representative_point()
        districts.append({
            'id': f'atlas/shaydon-proposed-{index + 1}',
            'name': name,
            'namingStatus': 'proposed',
            'official': False,
            'approximateBoundaries': True,
            'source': 'Atlas — проектные зоны на основе контура застройки',
            'geometry': mapping(geo),
            'center': [representative.x, representative.y],
            'bbox': list(geo.bounds),
        })
    result = {
        'type': 'AtlasDistrictCollection',
        'namingStatus': 'proposed',
        'official': False,
        'approximateBoundaries': True,
        'description': 'Проектные названия Atlas. Неофициальное деление застройки Шайдона на четыре зоны; границы не являются административными.',
        'source': 'Atlas — проектные зоны на основе контура застройки',
        'footprintSource': 'OpenStreetMap contributors / Geofabrik Tajikistan extract, 2026-09-06',
        'license': 'ODbL 1.0',
        'license_url': 'https://www.openstreetmap.org/copyright',
        'selection_bbox': BOUNDS,
        'source_tiles': source_tiles,
        'partition': 'Four equal-width NW–SE bands clipped to the main existing urban footprint around Shaydon center.',
        'districts': districts,
    }
    # Validate exact coverage and absence of overlaps beyond numerical noise.
    regions = [transform(world, shape(district['geometry'])) for district in districts]
    reconstructed = unary_union(regions)
    assert reconstructed.symmetric_difference(footprint).area < footprint.area * 1e-8
    assert abs(sum(region.area for region in regions) - reconstructed.area) < footprint.area * 1e-8
    assert all(shape(district['geometry']).covers(Point(district['center'])) for district in districts)
    output = ROOT / 'public' / 'districts.json'
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(json.dumps({'districts': len(districts), 'source_tiles': source_tiles,
                      'urban_pieces': len(pieces), 'urban_components': len(components),
                      'bytes': output.stat().st_size,
                      'districts_summary': [{key: d[key] for key in ('id', 'name', 'center', 'bbox')} for d in districts]}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

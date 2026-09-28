"""Extract exact street geometries for local street hit testing.

Uses native key and ID filters, retaining coordinates only for named roads or
roads that intersect Shaydon. It does not rewrite any source names.
"""
import argparse
from array import array
import json
from pathlib import Path
import sys
import time

import osmium


DRIVABLE = {
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary',
    'primary_link', 'secondary', 'secondary_link', 'tertiary',
    'tertiary_link', 'unclassified', 'residential', 'living_street', 'service',
}
NAME_KEYS = ('name:ru', 'name', 'name:tg', 'name:en')
TAG_KEYS = (*NAME_KEYS, 'ref', 'highway', 'alt_name', 'old_name', 'official_name',
            'surface', 'oneway', 'access', 'motor_vehicle', 'motorcar', 'service')


def extract(pbf, output, bounds, date):
    started = time.monotonic()
    named, candidates, named_ids, all_ids = [], [], set(), set()
    for way in osmium.FileProcessor(pbf, entities=osmium.osm.WAY).with_filter(osmium.filter.KeyFilter('highway')):
        tags = {key: way.tags[key] for key in TAG_KEYS if key in way.tags}
        has_name = any(tags.get(key) for key in (*NAME_KEYS, 'ref'))
        if not has_name and tags.get('highway') not in DRIVABLE:
            continue
        node_ids = array('q', (node.ref for node in way.nodes))
        if len(node_ids) < 2:
            continue
        record = {'id': f'way/{way.id}', 'tags': tags, 'nodes': node_ids}
        all_ids.update(node_ids)
        if has_name:
            named.append(record)
            named_ids.update(node_ids)
        else:
            candidates.append(record)
    print(f'Ways: {len(named)} named/ref; {len(candidates)} unnamed candidates; {len(all_ids)} required nodes', flush=True)
    coordinates, nearby_ids = {}, set()
    west, south, east, north = bounds
    for node in osmium.FileProcessor(pbf, entities=osmium.osm.NODE).with_filter(osmium.filter.IdFilter(all_ids)):
        lon, lat = node.location.lon, node.location.lat
        nearby = west <= lon <= east and south <= lat <= north
        if nearby:
            nearby_ids.add(node.id)
        if nearby or node.id in named_ids:
            coordinates[node.id] = [lon, lat]
    unnamed = [way for way in candidates if any(node_id in nearby_ids for node_id in way['nodes'])]
    selected = named + unnamed
    missing = {node_id for way in selected for node_id in way['nodes'] if node_id not in coordinates}
    del candidates, named_ids, all_ids
    if missing:
        for node in osmium.FileProcessor(pbf, entities=osmium.osm.NODE).with_filter(osmium.filter.IdFilter(missing)):
            coordinates[node.id] = [node.location.lon, node.location.lat]
    roads, invalid = [], []
    for way in selected:
        if any(node_id not in coordinates for node_id in way['nodes']):
            invalid.append(way['id'])
            continue  # Never join separated nodes across missing geometry.
        line = [coordinates[node_id] for node_id in way.pop('nodes')]
        tags = way['tags']
        name = next((tags[key] for key in NAME_KEYS if tags.get(key)), None)
        bbox = [min(point[0] for point in line), min(point[1] for point in line),
                max(point[0] for point in line), max(point[1] for point in line)]
        roads.append(dict(way, name=name, ref=tags.get('ref'), coordinates=line, bbox=bbox))
    result = {
        'source': 'OpenStreetMap contributors / Geofabrik Tajikistan extract',
        'source_url': 'https://download.geofabrik.de/asia/tajikistan.html',
        'date': date, 'license': 'ODbL 1.0',
        'license_url': 'https://www.openstreetmap.org/copyright',
        'selection_bbox': bounds,
        'selection': 'All named/ref highway ways in Tajikistan plus unnamed drivable ways intersecting Shaydon.',
        'roads': roads,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(json.dumps({'roads': len(roads), 'unnamed_shaydon': len(unnamed), 'invalid': invalid,
                      'bytes': output.stat().st_size, 'seconds': round(time.monotonic() - started, 1)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'public' / 'streets.json')
    parser.add_argument('--bbox', nargs=4, type=float, default=[70.335, 40.638, 70.386, 40.680], metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'))
    parser.add_argument('--date', default='2026-09-06')
    args = parser.parse_args()
    extract(args.pbf, args.output, args.bbox, args.date)

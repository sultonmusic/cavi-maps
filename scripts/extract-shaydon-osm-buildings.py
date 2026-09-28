"""Shaydon's OpenStreetMap buildings, each with its id and any height tags.

The base tiles keep outlines without ids, while the admin panel stores a building's
floors by id, so these few buildings ship as their own small file.

    python scripts/extract-shaydon-osm-buildings.py <tajikistan.osm.pbf> public/shaydon-osm-buildings.json
"""
import json
import sys

import osmium

# Shaydon and a margin around it, the same box as the Microsoft footprints.
BOUNDS = (70.318, 40.628, 70.402, 40.692)


def number(value, low, high):
    try:
        result = float(str(value).replace(',', '.').split()[0])
    except (ValueError, IndexError):
        return None
    return result if low <= result <= high else None


def main(source, destination):
    west, south, east, north = BOUNDS
    buildings = []
    # Every object is read, so untagged nodes still give the ways their locations.
    for item in osmium.FileProcessor(source).with_locations():
        if not item.is_way() or 'building' not in item.tags or not item.is_closed():
            continue
        ring = [[round(node.lon, 7), round(node.lat, 7)] for node in item.nodes if node.location.valid()]
        if len(ring) < 4:
            continue
        lon = sum(point[0] for point in ring) / len(ring)
        lat = sum(point[1] for point in ring) / len(ring)
        if not (west < lon < east and south < lat < north):
            continue
        tags = item.tags
        entry = {'id': f'way/{item.id}', 'ring': ring}
        name = tags.get('name:ru') or tags.get('name')
        if name:
            entry['name'] = name
        levels = number(tags.get('building:levels'), 1, 60)
        if levels:
            entry['levels'] = int(levels)
        height = number(tags.get('height'), 1, 500)
        if height:
            entry['height'] = height
        buildings.append(entry)

    buildings.sort(key=lambda building: building['id'])
    payload = {'source': 'OpenStreetMap contributors', 'licence': 'ODbL', 'area': 'Шайдон', 'buildings': buildings}
    with open(destination, 'w', encoding='utf-8') as out:
        json.dump(payload, out, ensure_ascii=False, separators=(',', ':'))
    print(f'kept {len(buildings)} OSM buildings in Shaydon '
          f'({sum("levels" in b for b in buildings)} with floors, {sum("height" in b for b in buildings)} with height)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])

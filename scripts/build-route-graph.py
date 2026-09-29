"""The routing graph for every way of getting about: one set of OpenStreetMap nodes and edges, each
edge marked with who may use it and what kind of road it is, so the route worker builds a network
per travel mode and prices each road for it (public/route-rules.js).

    road-graph.json      {"nodes_files": [...], "edges_files": [...], "modes": 2}
    graph-nodes-N.json   [[lat, lon], ...], 100 000 to a file
    graph-edges-N.json   [[from, to, flags], ...], 200 000 to a file

flags, access (bits 0-4): 1 one-way for motor vehicles, 2 closed to motor vehicles, 4 closed to
pedestrians, 8 closed to bicycles, 16 one-way for bicycles too. An edge with none of them is a
two-way street open to everyone, which is also what the older car-only graph meant by 0.
flags, road (bits 5-12): class << 5 (0 unknown, 1 motorway, 2 trunk, 3 primary, 4 secondary,
5 tertiary, 6 unclassified, 7 residential, 8 living street, 9 service, 10 driveway,
parking aisle or other minor service road, 11 footway or pedestrian street, 12 cycleway, 13 path,
14 steps, 15 track or bridleway), 512 unpaved, 1024 link road, 2048 has a name or a number,
4096 crossing. "modes": 2 marks a graph with these bits; "modes": 1 graphs have class 0 everywhere
and still route, by length alone. Old workers read the flags into bytes and keep bits 0-4 intact.

Cars keep to the streets they always used (motorway to service road, not private); pedestrians may
walk anything but motorways; bicycles and scooters ride streets, cycleways, paths and tracks, and
footways only where bicycles are allowed.

    python scripts/build-route-graph.py <tajikistan.osm.pbf> public
"""
import array
import collections
import json
import os
import pathlib
import sys

import osmium

CAR = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
       'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service'}
OTHER = {'footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'bridleway'}
CLASS = {'motorway': 1, 'motorway_link': 1, 'trunk': 2, 'trunk_link': 2, 'primary': 3, 'primary_link': 3,
         'secondary': 4, 'secondary_link': 4, 'tertiary': 5, 'tertiary_link': 5, 'unclassified': 6, 'road': 6,
         'residential': 7, 'living_street': 8, 'service': 9, 'pedestrian': 11, 'footway': 11, 'cycleway': 12,
         'path': 13, 'steps': 14, 'track': 15, 'bridleway': 15}
MINOR_SERVICE = {'driveway', 'parking_aisle', 'drive-through', 'emergency_access'}
UNPAVED = {'unpaved', 'dirt', 'ground', 'earth', 'gravel', 'fine_gravel', 'compacted', 'mud', 'sand', 'grass',
           'pebblestone', 'rock', 'clay', 'woodchips'}
UNPAVED_FLAG, LINK_FLAG, NAMED_FLAG, CROSSING_FLAG = 512, 1024, 2048, 4096
NODES_PER_FILE, EDGES_PER_FILE = 100_000, 200_000
counts = collections.Counter()


def closed(value):
    return value in ('no', 'private')


def open_to(value):
    return value in ('yes', 'designated', 'permissive', 'destination')


def modes(tags):
    highway = tags.get('highway')
    car = highway in CAR and not closed(tags.get('access')) and not closed(tags.get('motor_vehicle'))
    foot = highway not in ('motorway', 'motorway_link') and not closed(tags.get('foot')) \
        and (not closed(tags.get('access')) or open_to(tags.get('foot')))
    bike = highway not in ('motorway', 'motorway_link', 'steps') and not closed(tags.get('bicycle')) and tags.get('bicycle') != 'dismount' \
        and (highway not in ('footway', 'pedestrian') or open_to(tags.get('bicycle'))) \
        and (not closed(tags.get('access')) or open_to(tags.get('bicycle')))
    return car, foot, bike


def road_class(tags):
    found = CLASS.get(tags.get('highway'), 0)
    return 10 if found == 9 and tags.get('service') in MINOR_SERVICE else found


def unpaved(tags):
    surface = tags.get('surface')
    if surface is not None:
        return surface in UNPAVED
    grade = tags.get('tracktype')
    # A track is a dirt road unless it is graded solid (grade1, usually asphalt or concrete).
    return grade in ('grade2', 'grade3', 'grade4', 'grade5') or (tags.get('highway') == 'track' and grade != 'grade1')


def road_flags(tags):
    """Bits 5-12 of an edge's flags: what kind of road it is, for costs and snapping."""
    highway = tags.get('highway', '')
    crossing = 'crossing' in (tags.get('footway'), tags.get('cycleway'), tags.get('path'))
    return (road_class(tags) << 5) | (UNPAVED_FLAG if unpaved(tags) else 0) | (LINK_FLAG if highway.endswith('_link') else 0) \
        | (NAMED_FLAG if tags.get('name') or tags.get('ref') else 0) | (CROSSING_FLAG if crossing else 0)


class Graph(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.index = {}
        self.lat, self.lon = array.array('d'), array.array('d')
        self.start, self.end, self.flags = array.array('I'), array.array('I'), array.array('H')

    def node_index(self, node):
        found = self.index.get(node.ref)
        if found is None:
            found = self.index[node.ref] = len(self.lat)
            self.lat.append(round(node.lat, 6))
            self.lon.append(round(node.lon, 6))
        return found

    def way(self, way):
        tags = way.tags
        if tags.get('highway') not in CAR | OTHER or tags.get('area') == 'yes':
            return
        car, foot, bike = modes(tags)
        if not (car or foot or bike):
            return
        oneway = tags.get('oneway') in ('yes', '1', 'true', '-1') or tags.get('junction') == 'roundabout'
        bike_oneway = oneway and tags.get('oneway:bicycle') != 'no' and not str(tags.get('cycleway', '')).startswith('opposite')
        flags = (1 if oneway and car else 0) | (0 if car else 2) | (0 if foot else 4) | (0 if bike else 8) | (16 if bike and bike_oneway else 0)
        flags |= road_flags(tags)
        classed = road_class(tags) > 0
        ids = [self.node_index(node) for node in way.nodes if node.location.valid()]
        if tags.get('oneway') == '-1':
            ids.reverse()
        for a, b in zip(ids, ids[1:]):
            if a == b:
                continue
            self.start.append(a)
            self.end.append(b)
            self.flags.append(flags)
            counts['edges'] += 1
            counts['car'] += car
            counts['foot'] += foot
            counts['bike'] += bike
            counts['classed'] += classed


def main(pbf, public):
    graph = Graph()
    graph.apply_file(str(pbf), locations=True, idx='flex_mem')
    public = pathlib.Path(public)
    for old in list(public.glob('graph-nodes-*.json')) + list(public.glob('graph-edges-*.json')):
        old.unlink()
    nodes_files, edges_files = [], []
    for part, first in enumerate(range(0, len(graph.lat), NODES_PER_FILE)):
        rows = [[graph.lat[i], graph.lon[i]] for i in range(first, min(first + NODES_PER_FILE, len(graph.lat)))]
        (public / f'graph-nodes-{part}.json').write_text(json.dumps(rows, separators=(',', ':')), encoding='utf-8')
        nodes_files.append(f'/graph-nodes-{part}.json')
    for part, first in enumerate(range(0, len(graph.flags), EDGES_PER_FILE)):
        rows = [[graph.start[i], graph.end[i], graph.flags[i]] for i in range(first, min(first + EDGES_PER_FILE, len(graph.flags)))]
        (public / f'graph-edges-{part}.json').write_text(json.dumps(rows, separators=(',', ':')), encoding='utf-8')
        edges_files.append(f'/graph-edges-{part}.json')
    (public / 'road-graph.json').write_text(json.dumps({'nodes_files': nodes_files, 'edges_files': edges_files, 'modes': 2}, separators=(',', ':')), encoding='utf-8')
    print(f'Complete: {len(graph.lat)} nodes, {dict(counts)}, {len(nodes_files)} node files, {len(edges_files)} edge files', flush=True)


if __name__ == '__main__':
    main(*sys.argv[1:3])
    sys.stdout.flush()
    os._exit(0)

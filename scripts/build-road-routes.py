"""Road numbers and names for the whole of Tajikistan: the data behind the US-style route shields
("R-303", "РБ04"), the names written along main roads, the admin "Дороги" editor and the route
search, built from OpenStreetMap.

Ways are merged into roads ("routes"):
  * ref routes    every way that carries a road number (its own ref tag, a route=road relation it
                  belongs to, or a number at the start of its name), grouped by the primary number;
  * name routes   named main roads (motorway to tertiary) without a number, grouped by name and
                  connectivity (same-name pieces closer than 120 m are joined);
  * extra strokes unnamed, unnumbered main roads chained through junctions where they continue
                  almost straight (under 40 degrees), so the admin can give them a number.

Numbers are written one way: РБ + 2 digits (roads of republican significance, Latin RB accepted),
РҶ + 3 digits (the frequent РЧ typo and Latin RJ/RCH become РҶ), M41, AH7, E123, R-303 (local)
and foreign codes such as the Kyrgyz ЭМ-16 as they are. Anything else (words, "Old M41") is
dropped. The primary number of a way is the first of РБ, РҶ, R-, M/AH/E, foreign.

Output (UTF-8 JSON, one line), public/road-routes.json (kind "labelled": ref and name routes) and
public/road-routes-extra.json (kind "extra": the strokes, loaded by the admin and on demand):

    {"version": 1, "kind": "labelled" | "extra", "source": "...", "license": "ODbL 1.0",
     "scale": 100000, "names": [way names...],
     "routes": [{"id": "ref:R-303" | "name:<min way id>" | "way:<min way id>",
                 "ref": "R-303" | null, "refs": ["M41"] (other numbers on >= 20% of the length,
                 omitted when none), "name": "..." | null,
                 "hw": "motorway|trunk|primary|secondary|tertiary|other", "km": 12.3,
                 "ways": [[osm way id, name index or -1, flags, x0, y0, dx1, dy1, ...], ...]}]}

    flags: 1 one-way, 2 link, 4 tunnel, 8 bridge; x = round(lon * 1e5), y = round(lat * 1e5),
    the first point absolute and each next one a step from the one before; a one-way way runs in
    its direction of travel. Geometry is simplified (Douglas-Peucker 4 m labelled, 8 m extra).

Route ids are the keys of the admin edits (roadEdits "route/<id>"). "ref:" ids stay stable across
rebuilds. "name:" and "way:" ids use the smallest OSM way id, so an edit of such a road is left
orphaned when OpenStreetMap splits or merges that way; the admin panel lists orphaned edits with
a reset button.

    python scripts/build-road-routes.py ..\\tajikistan.osm.pbf public
"""
import argparse
import bisect
import collections
import datetime
import json
import math
import os
import pathlib
import re
import sys
import time
from array import array

import osmium
from shapely.geometry import LineString

CLASS_ORDER = {'rb': 0, 'rj': 1, 'local': 2, 'intl': 3, 'foreign': 4}
MAIN = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
        'secondary_link', 'tertiary', 'tertiary_link'}
REF_MINOR = {'unclassified', 'residential', 'living_street', 'service', 'road', 'track'}
SKIP = {'construction', 'proposed', 'platform', 'footway', 'path', 'steps', 'cycleway', 'pedestrian',
        'bridleway', 'bus_stop', 'corridor'}
HW_OUT = ('motorway', 'trunk', 'primary', 'secondary', 'tertiary')
STROKE_GROUP = {'motorway': 'major', 'trunk': 'major', 'primary': 'major', 'secondary': 'secondary',
                'tertiary': 'tertiary'}
NAME_KEYS = ('name:ru', 'name', 'name:tg', 'name:en')
REL_NAME_KEYS = ('name:ru', 'name', 'name:tg')
SCALE = 100000
LABELLED_TOLERANCE, EXTRA_TOLERANCE = 4.0, 8.0
MERGE_METERS, MERGE_CELL = 120.0, 0.002
STROKE_MAX_DEFLECTION, STROKE_LOOKAHEAD = 40.0, 25.0

RULES = (
    (re.compile(r'(?:RB|РБ|PБ|РB)-?0*(\d{1,2})', re.I), lambda m: 'РБ%02d' % int(m.group(1)), 'rb'),
    (re.compile(r'(?:R|Р|P)(?:J|DJ|DZH|CH|ZH|Ҷ|Ч|Ж|ДЖ)-?0*(\d{1,3})', re.I), lambda m: 'РҶ%03d' % int(m.group(1)), 'rj'),
    (re.compile(r'[MМ]-?(\d{1,3})', re.I), lambda m: 'M%d' % int(m.group(1)), 'intl'),
    (re.compile(r'(?:AH|АН|AН|АH)-?(\d{1,3})', re.I), lambda m: 'AH%d' % int(m.group(1)), 'intl'),
    (re.compile(r'[EЕ]-?(\d{2,3})', re.I), lambda m: 'E%d' % int(m.group(1)), 'intl'),
    (re.compile(r'[RРP]-?(\d{1,4})', re.I), lambda m: 'R-%d' % int(m.group(1)), 'local'),
)
FOREIGN = re.compile(r'[0-9A-Za-zА-Яа-яЁёҶҷҒғҚқҲҳӢӣӮӯ][0-9A-Za-zА-Яа-яЁёҶҷҒғҚқҲҳӢӣӮӯ-]{0,10}[0-9A-Za-zА-Яа-яЁёҶҷҒғҚқҲҳӢӣӮӯ]')
LOWER_PAIR = re.compile(r'[a-zа-яёҷғқҳӣӯ]{2}')
REF_TOKEN = r'(?:RB|РБ|РҶ|РЧ|M|М|AH|E|R|Р)\s*-?\s*\d+'
LEADING_REFS = re.compile(r'^\s*(?:\(?\s*' + REF_TOKEN + r'\s*\)?\s*[-–—,]?\s*)+', re.I)
BRACKET_REFS = re.compile(r'\s*\(\s*' + REF_TOKEN + r'\s*\)', re.I)
TRANSLIT = {'Р': 'R', 'Б': 'B', 'Ҷ': 'J', 'Ч': 'CH', 'Ж': 'ZH', 'М': 'M', 'А': 'A', 'Е': 'E', 'Э': 'E',
            'Н': 'N', 'К': 'K', 'В': 'V', 'Т': 'T', 'О': 'O', 'С': 'S', 'Х': 'H', 'Д': 'D'}


def canonical(token):
    """(canonical ref, class) for one raw ref token, or None for junk."""
    token = re.sub(r'\s+', '', token.replace('–', '-').replace('—', '-').replace('‑', '-'))
    if not token:
        return None
    for pattern, form, cls in RULES:
        match = pattern.fullmatch(token)
        if match:
            return form(match), cls
    if (FOREIGN.fullmatch(token) and re.search(r'\d', token) and re.search(r'[^\d-]', token)
            and not LOWER_PAIR.search(token)):
        return token, 'foreign'
    return None


def split_refs(value):
    """Canonical refs of a ref tag such as 'РБ09;;РҶ053' or 'РҶ033,РҶ034', in order, without repeats."""
    result = []
    for part in re.split(r'[;,]', value or ''):
        found = canonical(part)
        if found and found[0] not in result:
            result.append(found[0])
    return result


def ref_class(ref):
    found = canonical(ref)
    return found[1] if found else 'foreign'


def ref_key(text):
    """Same rule as refKey in lib/road-routes.ts: 'РБ-04' -> 'RB4', 'Р-303' -> 'R303'."""
    text = re.sub(r'[\s\-_.·]', '', (text or '').upper())
    text = ''.join(TRANSLIT.get(char, char) for char in text)
    return re.sub(r'\d+', lambda m: str(int(m.group(0))), text)


def clean_name(name, refs):
    """A way name without leading numbers ('RB04 (M41)', 'РБ01 (М34) Душанбе - Худжанд').
    Returns (name or None, numbers found at its start)."""
    if not name:
        return None, []
    found = []
    lead = LEADING_REFS.match(name)
    if lead:
        for token in re.findall(REF_TOKEN, lead.group(0), re.I):
            ref = canonical(token)
            if ref and ref[0] not in found:
                found.append(ref[0])
        name = name[lead.end():]
    name = re.sub(r'\s+', ' ', BRACKET_REFS.sub('', name)).strip(' -–—,')
    keys = {ref_key(ref) for ref in [*refs, *found]}
    if not name or ref_key(name) in keys or canonical(name):
        return None, found
    return name, found


def normal_name(name):
    return re.sub(r'\s+', ' ', name.casefold().replace('ё', 'е')).strip()


def natural(text):
    return [(0, int(part), '') if part.isdigit() else (1, 0, part) for part in re.split(r'(\d+)', text or '') if part]


def haversine(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 12742000.0 * math.asin(min(1.0, math.sqrt(a)))


def truthy(value):
    return value in ('yes', '1', 'true')


class Way:
    __slots__ = ('id', 'hw', 'link', 'refs', 'name', 'flags', 'reverse', 'nodes', 'points', 'meters', 'heads')

    def __init__(self, way_id, hw, link, refs, name, flags, reverse, nodes):
        self.id, self.hw, self.link, self.refs, self.name = way_id, hw, link, refs, name
        self.flags, self.reverse, self.nodes = flags, reverse, nodes
        self.points, self.meters, self.heads = None, 0.0, None


def read_relations(pbf):
    rel_refs, rel_name = collections.defaultdict(list), {}
    relations = 0
    for rel in osmium.FileProcessor(str(pbf), entities=osmium.osm.RELATION).with_filter(osmium.filter.TagFilter(('route', 'road'))):
        refs = split_refs(rel.tags.get('ref'))
        if not refs:
            continue
        relations += 1
        raw = next((rel.tags[key] for key in REL_NAME_KEYS if rel.tags.get(key)), None)
        name, _ = clean_name(raw, refs)
        for ref in refs:
            if name and ref not in rel_name:
                rel_name[ref] = name
        for member in rel.members:
            if member.type == 'w':
                target = rel_refs[member.ref]
                target.extend(ref for ref in refs if ref not in target)
    return rel_refs, rel_name, relations


def read_ways(pbf, rel_refs):
    ways = []
    for way in osmium.FileProcessor(str(pbf), entities=osmium.osm.WAY).with_filter(osmium.filter.KeyFilter('highway')):
        tags = way.tags
        hw = tags.get('highway')
        if hw in SKIP or tags.get('area') == 'yes' or len(way.nodes) < 2:
            continue
        refs = split_refs(tags.get('ref'))
        refs.extend(ref for ref in rel_refs.get(way.id, ()) if ref not in refs)
        raw_name = next((tags[key] for key in NAME_KEYS if tags.get(key)), None)
        name, from_name = clean_name(raw_name, refs)
        if not refs:
            refs = from_name
        if not (hw in MAIN or (refs and hw in REF_MINOR)):
            continue
        oneway = tags.get('oneway')
        reverse = oneway == '-1'
        is_oneway = reverse or truthy(oneway) or (oneway != 'no' and (tags.get('junction') in ('roundabout', 'circular') or hw == 'motorway'))
        link = hw.endswith('_link')
        flags = (1 if is_oneway else 0) | (2 if link else 0)
        flags |= 4 if tags.get('tunnel') not in (None, 'no') else 0
        flags |= 8 if tags.get('bridge') not in (None, 'no') else 0
        ways.append(Way(way.id, hw[:-5] if link else hw, link, refs, name, flags, reverse,
                        array('q', (node.ref for node in way.nodes))))
    return ways


def read_nodes(pbf, ways):
    """Sorted node ids and their coordinates (1e-7 degree integers) in parallel arrays, which keeps
    memory small compared with a dict of a million nodes."""
    ids = array('q', sorted({node for way in ways for node in way.nodes}))
    lon, lat = array('i', bytes(4 * len(ids))), array('i', bytes(4 * len(ids)))
    seen = bytearray(len(ids))
    for node in osmium.FileProcessor(str(pbf), entities=osmium.osm.NODE).with_filter(osmium.filter.IdFilter(ids)):
        index = bisect.bisect_left(ids, node.id)
        if index < len(ids) and ids[index] == node.id and node.location.valid():
            lon[index], lat[index], seen[index] = node.location.x, node.location.y, 1
    return ids, lon, lat, seen


def heading(local, reverse_end):
    """Unit vector from a way end to its first vertex at least 25 m away along the way."""
    points = local[::-1] if reverse_end else local
    x0, y0 = points[0]
    walked, last = 0.0, points[0]
    for x, y in points[1:]:
        walked += math.hypot(x - last[0], y - last[1])
        last = (x, y)
        if walked >= STROKE_LOOKAHEAD:
            break
    dx, dy = last[0] - x0, last[1] - y0
    size = math.hypot(dx, dy) or 1.0
    return dx / size, dy / size


def shape(ways, node_ids, node_lon, node_lat, seen):
    """Full-resolution length, simplified quantized points and end headings for every way;
    returns the ways whose nodes are all present (never join across missing geometry)."""
    kept, missing = [], 0
    for way in ways:
        coords = []
        for node in way.nodes:
            index = bisect.bisect_left(node_ids, node)
            if index >= len(node_ids) or node_ids[index] != node or not seen[index]:
                coords = None
                break
            coords.append((node_lon[index] / 1e7, node_lat[index] / 1e7))
        if coords is None:
            missing += 1
            continue
        if way.reverse:
            coords.reverse()
        way.meters = sum(haversine(*coords[i], *coords[i + 1]) for i in range(len(coords) - 1))
        lat0 = sum(point[1] for point in coords) / len(coords)
        kx = 111320.0 * math.cos(math.radians(lat0))
        local = [(lon * kx, lat * 110540.0) for lon, lat in coords]
        tolerance = LABELLED_TOLERANCE if (way.refs or way.name) else EXTRA_TOLERANCE
        simple = list(LineString(local).simplify(tolerance, preserve_topology=False).coords) if len(local) > 2 else local
        points = []
        for x, y in simple:
            point = (round(x / kx * SCALE), round(y / 110540.0 * SCALE))
            if not points or points[-1] != point:
                points.append(point)
        if len(points) < 2:
            ends = [(round(lon * SCALE), round(lat * SCALE)) for lon, lat in (coords[0], coords[-1])]
            points = ends if ends[0] != ends[1] else []
        if len(points) < 2:
            missing += 1
            continue
        way.points = points
        if not way.refs and not way.name:
            way.heads = (heading(local, False), heading(local, True))
        kept.append(way)
    return kept, missing


def dominant(pairs):
    """(value, share of the total) of the value with the largest summed weight."""
    totals = collections.Counter()
    for value, weight in pairs:
        totals[value] += weight
    if not totals:
        return None, 0.0
    value, weight = max(totals.items(), key=lambda item: (item[1], str(item[0])))
    return value, weight / (sum(totals.values()) or 1.0)


def route_hw(ways):
    hw, _ = dominant((way.hw, way.meters or 1.0) for way in ways)
    return hw if hw in HW_OUT else 'other'


def dominant_name(ways, minimum):
    spellings = collections.defaultdict(collections.Counter)
    for way in ways:
        if way.name:
            spellings[normal_name(way.name)][way.name] += way.meters or 1.0
    key, _ = dominant((normal_name(way.name), way.meters or 1.0) for way in ways if way.name)
    total = sum(way.meters or 1.0 for way in ways)
    named = sum(way.meters or 1.0 for way in ways if way.name and normal_name(way.name) == key)
    if key is None or named / (total or 1.0) < minimum:
        return None
    return spellings[key].most_common(1)[0][0]


class Union:
    def __init__(self, size):
        self.parent = list(range(size))

    def find(self, item):
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def join(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.parent[max(a, b)] = min(a, b)


def name_components(ways):
    """Same-name ways joined by shared nodes, then pieces whose closest vertices are within 120 m."""
    union = Union(len(ways))
    owner = {}
    for index, way in enumerate(ways):
        for node in way.nodes:
            if node in owner:
                union.join(index, owner[node])
            else:
                owner[node] = index
    cells = collections.defaultdict(list)
    for index, way in enumerate(ways):
        for x, y in way.points:
            cells[(x // (MERGE_CELL * SCALE), y // (MERGE_CELL * SCALE))].append((x, y, index))
    for (cx, cy), items in cells.items():
        for nx in (cx - 1, cx, cx + 1):
            for ny in (cy - 1, cy, cy + 1):
                others = cells.get((nx, ny))
                if not others:
                    continue
                for x, y, a in items:
                    for ox, oy, b in others:
                        if union.find(a) == union.find(b):
                            continue
                        lat = y / SCALE
                        dx = (ox - x) / SCALE * 111320.0 * math.cos(math.radians(lat))
                        dy = (oy - y) / SCALE * 110540.0
                        if dx * dx + dy * dy <= MERGE_METERS * MERGE_METERS:
                            union.join(a, b)
    groups = collections.defaultdict(list)
    for index, way in enumerate(ways):
        groups[union.find(index)].append(way)
    return list(groups.values())


def strokes(ways):
    """Unnamed main ways chained through junctions where the road continues under 40 degrees."""
    by_id = {way.id: way for way in ways}
    ends = collections.defaultdict(list)
    for way in ways:
        group = STROKE_GROUP.get(way.hw)
        if group is None or way.link:
            continue
        ends[(way.nodes[-1] if way.reverse else way.nodes[0], group)].append((way.id, 0))
        ends[(way.nodes[0] if way.reverse else way.nodes[-1], group)].append((way.id, 1))
    partner = {}
    limit = math.cos(math.radians(STROKE_MAX_DEFLECTION))
    for items in ends.values():
        if len(items) < 2:
            continue
        pairs = []
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                (wa, ea), (wb, eb) = items[i], items[j]
                if wa == wb:
                    continue
                ha, hb = by_id[wa].heads[ea], by_id[wb].heads[eb]
                straight = -(ha[0] * hb[0] + ha[1] * hb[1])  # cos of the deflection
                if straight >= limit:
                    pairs.append((-straight, items[i], items[j]))
        pairs.sort()
        for _, a, b in pairs:
            if a not in partner and b not in partner:
                partner[a], partner[b] = b, a
    visited, result = set(), []
    for way in ways:
        if way.id in visited or STROKE_GROUP.get(way.hw) is None or way.link:
            continue
        chain = [way.id]
        visited.add(way.id)
        for end in (1, 0):
            current, exit_end = way.id, end
            while (current, exit_end) in partner:
                nxt, entry = partner[(current, exit_end)]
                if nxt in visited:
                    break
                visited.add(nxt)
                chain.append(nxt)
                current, exit_end = nxt, 1 - entry
        result.append([by_id[way_id] for way_id in chain])
    return result


def route_record(route_id, ref, refs, name, ways, names, name_index):
    # One spelling per name inside a road ('Проспект  Рудаки' and 'проспект Рудаки'), so its
    # along-road name is not split between spellings.
    spellings = collections.defaultdict(collections.Counter)
    for way in ways:
        if way.name:
            spellings[normal_name(way.name)][way.name] += way.meters or 1.0
    records = []
    for way in sorted(ways, key=lambda way: way.id):
        index = -1
        if way.name:
            text = spellings[normal_name(way.name)].most_common(1)[0][0]
            if text not in name_index:
                name_index[text] = len(names)
                names.append(text)
            index = name_index[text]
        x0, y0 = way.points[0]
        record = [way.id, index, way.flags, x0, y0]
        for (xa, ya), (xb, yb) in zip(way.points, way.points[1:]):
            record += [xb - xa, yb - ya]
        records.append(record)
    result = {'id': route_id, 'ref': ref}
    if refs:
        result['refs'] = refs
    result.update(name=name, hw=route_hw(ways), km=round(sum(way.meters for way in ways) / 1000, 1), ways=records)
    return result


def route_id(prefix, text):
    return prefix + re.sub(r'[^\w.\-]', '', text)


def build(pbf, out_dir, date):
    started = time.monotonic()
    rel_refs, rel_name, relations = read_relations(pbf)
    print(f'Relations: {relations} numbered route=road; {len(rel_refs)} member ways', flush=True)
    ways = read_ways(pbf, rel_refs)
    del rel_refs
    print(f'Ways: {len(ways)} kept', flush=True)
    node_ids, node_lon, node_lat, seen = read_nodes(pbf, ways)
    print(f'Nodes: {sum(seen)} of {len(node_ids)} found', flush=True)
    ways, missing = shape(ways, node_ids, node_lon, node_lat, seen)
    del node_ids, node_lon, node_lat, seen

    by_ref = collections.defaultdict(list)
    named = collections.defaultdict(list)
    unlabelled = []
    for way in ways:
        if way.refs:
            primary = min(way.refs, key=lambda ref: (CLASS_ORDER[ref_class(ref)], way.refs.index(ref)))
            by_ref[primary].append(way)
        elif way.name:
            named[normal_name(way.name)].append(way)
        else:
            unlabelled.append(way)

    names, name_index, labelled = [], {}, []
    for ref, group in by_ref.items():
        total = sum(way.meters for way in group) or 1.0
        others = collections.Counter()
        for way in group:
            for other in way.refs:
                if other != ref:
                    others[other] += way.meters
        refs = sorted((other for other, meters in others.items() if meters / total >= 0.2),
                      key=lambda other: (CLASS_ORDER[ref_class(other)], natural(other)))
        name = rel_name.get(ref) or dominant_name(group, 0.3)
        labelled.append(route_record(route_id('ref:', ref), ref, refs, name, group, names, name_index))
    for group in named.values():
        for component in name_components(group):
            name = dominant_name(component, 0.0)
            labelled.append(route_record('name:%d' % min(way.id for way in component), None, [], name, component, names, name_index))
    labelled.sort(key=lambda r: (CLASS_ORDER[ref_class(r['ref'])] if r['ref'] else 9, natural(r['ref']), r['name'] or '', r['id']))

    extra = []
    extra_names, extra_index = [], {}
    for chain in strokes(unlabelled):
        extra.append(route_record('way:%d' % min(way.id for way in chain), None, [], None, chain, extra_names, extra_index))
    extra.sort(key=lambda r: (HW_OUT.index(r['hw']) if r['hw'] in HW_OUT else 9, -r['km'], r['id']))

    source = f'OpenStreetMap contributors, Geofabrik extract of {date}'
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = {}
    for kind, routes, table, filename in (('labelled', labelled, names, 'road-routes.json'),
                                          ('extra', extra, extra_names, 'road-routes-extra.json')):
        path = out_dir / filename
        payload = {'version': 1, 'kind': kind, 'source': source, 'license': 'ODbL 1.0', 'scale': SCALE,
                   'names': table, 'routes': routes}
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        classes = collections.Counter(ref_class(r['ref']) if r['ref'] else 'none' for r in routes)
        summary[filename] = {'routes': len(routes), 'classes': dict(classes),
                             'ways': sum(len(r['ways']) for r in routes),
                             'vertices': sum((len(w) - 3) // 2 for r in routes for w in r['ways']),
                             'km': round(sum(r['km'] for r in routes)), 'bytes': path.stat().st_size}
    summary['dropped_ways'] = missing
    summary['seconds'] = round(time.monotonic() - started, 1)
    print(json.dumps(summary, ensure_ascii=False), flush=True)


def extract_date(pbf):
    try:
        stamp = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING).header().get('osmosis_replication_timestamp')
        if stamp:
            return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')).strftime('%d.%m.%Y')
    except Exception:
        pass
    return datetime.datetime.fromtimestamp(pathlib.Path(pbf).stat().st_mtime).strftime('%d.%m.%Y')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pbf', type=pathlib.Path, help='tajikistan.osm.pbf (or a small .osm file for tests)')
    parser.add_argument('out_dir', type=pathlib.Path, nargs='?', default=pathlib.Path(__file__).resolve().parents[1] / 'public')
    parser.add_argument('--date', help='extract date for the source line, DD.MM.YYYY (default: from the file)')
    args = parser.parse_args()
    build(args.pbf, args.out_dir, args.date or extract_date(args.pbf))
    sys.stdout.flush()
    os._exit(0)  # skip the slow teardown of large structures on Windows

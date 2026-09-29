# Cavi Maps: local geography

The application renders MapLibre GL vector tiles that the browser encodes from the same-origin JSON bundles (`lib/mvt.ts`); nothing is fetched from a tile server. It does not use OpenStreetMap's tile servers, Overpass at runtime, remote map styles, or a remote routing service.

Source: https://download.geofabrik.de/asia/tajikistan.html (2026-09-06 extract).
License: OpenStreetMap contributors, ODbL 1.0. See public/atlas-data/LICENSE.txt.

Rebuild data:
1. Put tajikistan.osm.pbf in the parent directory of the project.
2. Install scripts/requirements-atlas.txt with Python 3.13.
3. Run python scripts/build-atlas.py.
4. Run python scripts/add-country-border.py.
5. Run python scripts/split-graph.py.
6. Run python scripts/bundle-tiles.py.
7. Run node scripts/check-renderer.mjs and node scripts/check-routing.mjs --real.

Geometry tiers: 7 (country), 10 (regions), 13 (local geometry, overzoomed to 19). Only tiers 10 and 13 carry the asphalt style, so admin asphalt is hidden below zoom 10 to match. `check-mvt.mjs` decodes an encoded tile and `check-shaydon.mjs` verifies the shipped Shaydon dataset. `extract-shaydon-osm-buildings.py <pbf> public/shaydon-osm-buildings.json` ships Shaydon's OSM buildings with their ids, so floors set in the admin panel attach to them. Building footprints are kept unsimplified before quantization. Geometry is clipped to tile bounds with a small stroke buffer. Canvas applies the visual style locally. Geographic coverage is limited to the source extract.

Routing uses a local directed road graph and A* in a Web Worker. It respects basic one-way tags and excludes roads marked private or forbidden to motor vehicles. It does not interpret turn restrictions, conditional access, live closures, or traffic. Routes are explicitly labeled approximate.

Place pictograms: `lib/poi-icons.mjs` maps OSM tags (amenity, shop, tourism, healthcare, historic, leisure, religion) and admin business categories to a lucide icon name and a rank from 0 to 4. The rank decides which discs show at zoom 12-14 and which one wins a collision. `node scripts/build-poi-glyphs.mjs` turns those icons from the installed lucide-react into plain SVG path data in `lib/poi-glyphs.mjs`, keeping lucide's ISC notice and Feather's MIT notice. The module is committed and has no runtime dependency on lucide. `--check` fails when the file is stale. `lib/poi-draw.ts` draws each `poi:<icon>` image on a canvas at the screen's pixel density when MapLibre asks for it (styleimagemissing), so no sprite or glyph server is needed offline. `node --experimental-strip-types scripts/check-poi-icons.mjs` verifies the whole set.

`check-building-pick.mjs` tests the 3D tap. A tapped pixel is a line of sight from the camera, and `lib/building-ray.mjs` finds where that line first enters a building's walls or its pitched roof. The pure geometry is compared with a brute-force march along random rays. `lib/building-pick.ts` is run against a stand-in pinhole-camera map, including the Khujand case where a tap on a 40 m tower's roof used to land on the ground behind it. Country-house keys are 'cty:<gx>-<gy>:<record index>', so re-running build-country-houses.py or estimate-country-heights.mjs renumbers them. Nothing persists these keys today.

### Estimated heights for the country's houses (AHB2)
`node scripts/estimate-country-heights.mjs [public/atlas-houses]` rewrites every house file from AHB1 to AHB2 in place. It handles one file at a time (a temp file plus a rename, so memory stays low), and running it again changes nothing.

AHB2 adds one flags byte per house:
- bits 0-2: the facade style (1 house, 2 block, 3 office, 4 hall, 5 shop);
- bit 3: the height is an estimate.

Where no source states a height, it is guessed from the footprint's tightest rectangle:
- under 400 m²: no height (the map's 4 m);
- a slab 9.5-15.5 m wide and at least 36 m long that fills 85% or more of its rectangle: 16 m (a Soviet five-storey block);
- 2500 m² and up: 8 m (a hall);
- anything else: 7 m.

Every guess is flagged, so it is never shown as a surveyed height: houses:// features carry `stated` only for heights a source gave. index.json gets format AHB2, counts.estimated and counts.styles.

**After re-running scripts/build-country-houses.py, run this script again**, then `node scripts/check-country-houses.mjs`, and bump the service-worker cache.

### Facade and detail check
`node scripts/check-facades.mjs` tests lib/facades.mjs, lib/mesh-kit.mjs and lib/greenery.mjs:
- decals per wall, floor and door; parapets and rooftop boxes (none over a courtyard house);
- wall tones, and the light matching MapLibre's extrusion shading;
- shop fronts and the vertex budget;
- street and park trees clear of houses, carriageways, junctions and water;
- the roof pattern and park trees fixed to the world across rebuilds.

It then builds one real neighbourhood, central Khujand, from public/atlas-houses. That must stay under 90k decal and 40k solid vertices, and under 150 ms of the process's own processor time (best of five), so a busy machine does not fail it.

### How building detail works
Up close (from z15.9, in full by z16.5), lib/detail-layer.ts (custom layer 'city-detail', drawn under the selection) dresses the extruded houses within about 450 m of the view centre:
- window grids per 3 m floor;
- shop fronts where a shop, café, pharmacy or bank stands;
- entrance doors with canopies;
- grey roofs behind white parapets, stair housings and AC boxes;
- soft contact shadows;
- decorative street and park trees (STREET_TREES in lib/greenery.mjs), never in water.

Walls take one of eight light tones under a map-anchored light (BUILDING_LIGHT), so their shading no longer turns with the screen, and the extrusions are opaque from z15. Roofs turn grey as the map tilts (8-30°). The roof pattern and the park trees are fixed in Web Mercator, so they do not jump when the mesh is rebuilt. A country house's tone and its small height lift (at most 0.28 m, against roof flicker where footprints overlap) come from lib/facades.mjs outlineTone/liftedHeight, both in the houses:// tiles and in the detail mesh.

Shop fronts come from every place the map has shown so far (atlas.setPoints feeds detail.addPlaces). A category filter never takes one away, and only a newly seen shop near the middle triggers a rebuild. New houses, streets or mapped trees call detail.invalidate().

On phones with 2 GB of memory or less, the radius shrinks to 320 m. The Profile switch «Подробные здания» (lib/profile-store.ts readBuildingDetail, atlas.setBuildingDetail) turns the layer off; `atlas.buildingDetailStats()` reports the last rebuild. The GL and mesh helpers shared by every custom 3D layer live in lib/gl-kit.ts and lib/mesh-kit.mjs.

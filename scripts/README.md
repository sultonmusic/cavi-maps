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

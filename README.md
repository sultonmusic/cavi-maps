# Cavi Maps

Offline-first 3D map of Tajikistan with an in-browser driving navigator, focused on Shaydon.
Built with React 19, Vite and MapLibre GL 5. Interface language: Russian.

**Live site:** https://sultonmusic.github.io/cavi-maps/
Also hosted on Firebase: https://capline-tj-map.web.app

## Run locally

```bash
npm ci
npm run dev        # http://localhost:5173
npm run check      # TypeScript
npm run build      # dist/ + offline manifest
```

`ATLAS_BASE=/cavi-maps/ npm run build` produces the GitHub Pages copy. Every push to `main`
rebuilds it via `.github/workflows/pages.yml` into the `gh-pages` branch;
`bash scripts/deploy-gh-pages.sh` does the same from a local machine.

## Where things are

| Path | What |
| --- | --- |
| `app/page.tsx` | Main map UI |
| `app/admin.tsx` | Admin panel (`/admin`) |
| `components/route-planner.tsx` | Route planner and turn-by-turn navigator |
| `lib/atlas-gl.ts` | MapLibre map: tiles, 3D houses, roads, objects |
| `public/route-worker.js` | Routing (runs in a Web Worker) |
| `public/sw.js` | Offline cache (service worker) |
| `public/` | Map data (OpenStreetMap / Microsoft footprints, ODbL) |
| `scripts/` | Data build scripts and checks |

Detailed documentation in Russian: [README-RU.md](README-RU.md), [ADMIN-RU.md](ADMIN-RU.md).
Contributing with an AI assistant: [AGENTS.md](AGENTS.md).

## Data license

© OpenStreetMap contributors, ODbL. Building footprints: Microsoft Global ML Building Footprints, ODbL.
See `public/atlas-data/LICENSE.txt`.

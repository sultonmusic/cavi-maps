# Notes for AI assistants (Claude, Codex, Copilot, Gemini…)

Read this before changing Cavi Maps.

## Rules

- UI text is **Russian**. Keep new strings in Russian and in the same tone.
- The map must keep working **offline**: no external tile servers, fonts, CDNs or analytics.
  All map data is served from `public/`.
- The site is served from two roots: `/` (Firebase) and `/cavi-maps/` (GitHub Pages).
  Never write `fetch('/file.json')`, `new Worker('/x.js')` or `href="/page"` directly —
  wrap the path with `siteUrl('/file.json')` from `lib/site-url.ts`.
  In `public/sw.js` and `public/route-worker.js` resolve paths from the script's own location.
- When you change anything cached by the service worker, bump the cache name in
  `public/sw.js` **and** the version in `scripts/build-offline-manifest.mjs` together.
- Do not commit `security/`, `dist/` or `node_modules/`.
- Do not hand-edit generated data in `public/atlas-*` or `public/graph-*.json`;
  regenerate it with the matching script in `scripts/` (see README-RU.md).

## Before you push

```bash
npm run check
npm run build
node scripts/check-routing.mjs --real
```

`scripts/check-planner.mjs` is an old harness that fails regardless of changes — ignore it.

Pushing to `main` redeploys https://sultonmusic.github.io/cavi-maps/ automatically
(watch the **Actions** tab). Prefer small commits with clear messages.

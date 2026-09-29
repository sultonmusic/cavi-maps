# Deployment notes

The source of truth is the `main` branch. Build output in `dist/` is generated and must not be committed to `main`.

## GitHub Pages (current public site)

Public URL: https://sultonmusic.github.io/cavi-maps/

The site is served from the generated `gh-pages` branch. On a computer with Node 22+ and Git push access:

```bash
git pull origin main
npm ci
npm run check
node scripts/check-routing.mjs --real
bash scripts/deploy-gh-pages.sh
```

The script builds with `ATLAS_BASE=/cavi-maps/`, publishes `dist/` to `gh-pages`, then restores a root build locally. When GitHub Actions is available, `.github/workflows/pages.yml` also publishes on a push to `main`. If Actions is blocked by billing, use the script.

## Firebase Hosting (later, from a PC)

Firebase project: `capline-tj-map`. Main Hosting site: `capline-tj-map`. The second site `capline-tj-map-admin` is a separate target; do not deploy it accidentally.

From the current `main` checkout with Node 22+:

```bash
git pull origin main
npm ci
npm run check
npm run build
node scripts/check-routing.mjs --real
npx firebase-tools@14 login
npx firebase-tools@14 deploy --only hosting:capline-tj-map --project capline-tj-map
```

The default Vite base is `/`, which is correct for Firebase. Authenticate in the CLI with a Google account that has deploy access. Do not commit private keys, `dist/`, or `node_modules/`. The Firebase GitHub workflow is manual-only; a normal push to `main` does not deploy Firebase.

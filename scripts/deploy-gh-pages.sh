#!/usr/bin/env bash
# Publishes the site to GitHub Pages from this computer (use when GitHub Actions cannot run).
# Builds the /cavi-maps/ copy, force-pushes it to the gh-pages branch, then rebuilds dist/ for the root.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
MSYS_NO_PATHCONV=1 ATLAS_BASE=/cavi-maps/ npm run build
cp -r dist/. "$out" && cp "$out/index.html" "$out/404.html" && touch "$out/.nojekyll"
rev="$(git rev-parse --short HEAD)"
git -C "$out" init -q -b gh-pages
git -C "$out" add -A
git -C "$out" -c user.name="$(git config user.name || echo Capline Group)" -c user.email="$(git config user.email || echo noreply@example.com)" commit -q -m "Deploy Cavi Maps $rev"
git -C "$out" -c http.postBuffer=524288000 push -f "$(git remote get-url origin)" gh-pages
rm -rf "$out"
npm run build

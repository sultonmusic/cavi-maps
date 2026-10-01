#!/usr/bin/env bash
# Publishes the site to GitHub Pages from this computer (use when GitHub Actions cannot run).
# Builds for the current repository, publishes gh-pages, then rebuilds dist/ for the root.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
atlas_remote="$(git remote get-url origin)"
atlas_repo_name="${atlas_remote##*/}"
atlas_repo_name="${atlas_repo_name%.git}"
if [[ ! "$atlas_repo_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Cannot determine the Pages base from the origin repository name." >&2
  exit 1
fi
MSYS_NO_PATHCONV=1 ATLAS_BASE="/${atlas_repo_name}/" npm run build
cp -r dist/. "$out" && cp "$out/index.html" "$out/404.html" && touch "$out/.nojekyll"
rev="$(git rev-parse --short HEAD)"
git -C "$out" init -q -b gh-pages
git -C "$out" add -A
git -C "$out" -c user.name="$(git config user.name || echo Capline Group)" -c user.email="$(git config user.email || echo noreply@example.com)" commit -q -m "Deploy Cavi Maps $rev"
git -C "$out" -c http.postBuffer=524288000 push -f "$(git remote get-url origin)" gh-pages
rm -rf "$out"
npm run build

/* The platform is called Cavi Maps, by Capline Group. This check fails on any user-visible old
 * name ("Atlas", "Атлас Мэп") left in the pages, code strings, voice prompts, service worker and
 * docs, and checks the page title, the web-app manifest, the app icons, and that
 * public/favicon.svg and components/cavi-mark.tsx are the same drawing.
 *
 *   node scripts/check-brand.mjs
 *
 * Kept on purpose and never reported: code names (AtlasGL, createAtlasGL, AtlasLabel, ATLAS_BASE),
 * tag keys atlas:*, storage keys, CSS classes and folders atlas-*, the service-worker cache
 * prefix, the 'Atlas Local CA' certificate already installed on phones, old names inside
 * generated data (districts.json, streets.json) and real business names in places.json.
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_BYLINE, APP_COLOR, APP_NAME, APP_SPOKEN, APP_TITLE} from '../lib/brand.mjs';
import {arrivalPhrase} from '../lib/travel.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(path.join(root, file), 'utf8');
/** Shared files that other items integrate; until then they are reported apart. */
const AWAITING = new Set(['app/page.tsx', 'app/admin.tsx']);
const list = (folder, test) => existsSync(path.join(root, folder))
  ? readdirSync(path.join(root, folder), {withFileTypes: true}).filter(e => e.isFile() && test.test(e.name)).map(e => `${folder}/${e.name}`).sort() : [];

const scanned = [...new Set([
  'index.html', 'serve.mjs',
  ...list('app', /\.tsx$/), ...list('components', /\.tsx$/), ...list('lib', /\.(ts|mjs)$/),
  ...list('public', /\.(html|js|webmanifest|svg)$/), 'public/atlas-data/LICENSE.txt',
  'README.md', 'README-RU.md', 'ADMIN-RU.md', 'GPS-HTTPS.md', 'STREET-SOURCES.md', 'scripts/README.md',
])];

const OLD_NAME = /(?<![A-Za-z_$\-\/.])(Atlas|ATLAS|Атлас|АТЛАС)(?![A-Za-z_$:\-])/g;
const OLD_LOGO = />\s*atlas\s*</g;  // the admin header's lower-case "atlas." word mark
const blank = text => text.replace(/[^\n]/g, ' ');
/** Comments are not shown to anyone; blank them out but keep the line numbers. */
function visibleText(file, text) {
  if (/\.(tsx?|mjs|js)$/.test(file)) {
    text = text.replace(/(^|[\s{}();,=?&|!>[])(\/\*[\s\S]*?\*\/)/g, (_, before, comment) => before + blank(comment));
    text = text.replace(/(^|[^:'"\\])(\/\/.*)$/gm, (_, before, comment) => before + blank(comment));
  }
  if (/\.(html|svg|md)$/.test(file)) text = text.replace(/<!--[\s\S]*?-->/g, blank);
  return text.replaceAll('Atlas Local CA', '              ');
}

const problems = new Map();  // file -> [message]
const report = (file, message) => { if (!problems.has(file)) problems.set(file, []); problems.get(file).push(message); };
let files = 0;
for (const file of scanned) {
  if (!existsSync(path.join(root, file))) { report(file, 'file is missing'); continue; }
  files++;
  const text = visibleText(file, read(file));
  for (const pattern of [OLD_NAME, OLD_LOGO]) for (const match of text.matchAll(pattern)) {
    const line = text.slice(0, match.index).split('\n').length;
    const start = text.lastIndexOf('\n', match.index) + 1;
    const context = text.slice(Math.max(start, match.index - 40), match.index + match[0].length + 40).replace(/\s+/g, ' ').trim();
    report(file, `${line}: old name «${match[0].replace(/[<>\s]/g, '')}» in …${context}…`);
  }
}

// The page head: title, description and install links. Vite prefixes the root-relative links with the base.
const html = read('index.html');
const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
if (title !== APP_TITLE) report('index.html', `<title> is «${title}», expected «${APP_TITLE}»`);
for (const [what, pattern] of [['the manifest link', /<link rel="manifest" href="\/manifest\.webmanifest">/],
  ['the SVG favicon', /<link rel="icon" href="\/favicon\.svg"/], ['the apple-touch-icon', /<link rel="apple-touch-icon" href="\/icon-[\w-]+\.png">/],
  ['a description naming Cavi Maps', /<meta name="description" content="[^"]*Cavi Maps/], ['theme-color', new RegExp(`<meta name="theme-color" content="${APP_COLOR}">`)]])
  if (!pattern.test(html)) report('index.html', `missing ${what}`);

// The web-app manifest: names, relative paths (the site lives at / and at /cavi-maps/) and real icons.
const pngSize = file => { const b = readFileSync(path.join(root, file)); return b.toString('latin1', 1, 4) === 'PNG' ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : null; };
try {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  if (manifest.short_name !== APP_NAME) report('public/manifest.webmanifest', `short_name is «${manifest.short_name}», expected «${APP_NAME}»`);
  if (manifest.name !== APP_TITLE) report('public/manifest.webmanifest', `name is «${manifest.name}», expected «${APP_TITLE}»`);
  if (!manifest.description?.includes(APP_BYLINE)) report('public/manifest.webmanifest', `description lacks «${APP_BYLINE}»`);
  if (manifest.theme_color !== APP_COLOR) report('public/manifest.webmanifest', `theme_color is not ${APP_COLOR}`);
  for (const key of ['start_url', 'scope']) if (manifest[key] !== './') report('public/manifest.webmanifest', `${key} must be './' so the app works under / and /cavi-maps/`);
  const need = new Set(['192x192 any', '512x512 any', '512x512 maskable']);
  for (const icon of manifest.icons ?? []) {
    if (/^(\/|https?:)/.test(icon.src)) { report('public/manifest.webmanifest', `icon ${icon.src} must be relative`); continue; }
    const file = `public/${icon.src}`;
    if (!existsSync(path.join(root, file))) { report('public/manifest.webmanifest', `icon ${icon.src} does not exist; run python scripts/make-app-icons.py`); continue; }
    if (icon.type === 'image/png') {
      const size = pngSize(file);
      if (size !== icon.sizes) report(file, `is ${size ?? 'not a PNG'}, the manifest says ${icon.sizes}`);
      for (const purpose of (icon.purpose ?? 'any').split(' ')) need.delete(`${icon.sizes} ${purpose}`);
    }
  }
  for (const missing of need) report('public/manifest.webmanifest', `no ${missing} PNG icon`);
} catch (error) { report('public/manifest.webmanifest', `unreadable: ${error.message}`); }

// One drawing: the generated favicon and the React mark share the tile radius, the C and the dot.
const shape = (text, stroke) => ({
  rx: /<rect[^>]*\brx="([\d.]+)"/.exec(text)?.[1], d: /<path[^>]*\bd="([^"]+)"/.exec(text)?.[1],
  stroke: new RegExp(`${stroke}="([\\d.]+)"`).exec(text)?.[1], dot: /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(text)?.slice(1).join(','),
});
const favicon = shape(read('public/favicon.svg'), 'stroke-width'), mark = shape(read('components/cavi-mark.tsx'), 'strokeWidth');
for (const key of Object.keys(favicon)) if (!favicon[key] || favicon[key] !== mark[key])
  report('components/cavi-mark.tsx', `${key} is ${mark[key]} but public/favicon.svg has ${favicon[key]}; draw both from scripts/make-app-icons.py`);
if (!/fill="#00866a"/.test(read('public/favicon.svg')) || APP_COLOR !== '#00866a') report('public/favicon.svg', `tile colour differs from ${APP_COLOR}`);

// Static pages open at /page.html and at /cavi-maps/page.html: links must be relative.
for (const file of list('public', /\.html$/)) for (const match of read(file).matchAll(/\b(?:href|src)="\/(?!\/)[^"]*"/g))
  report(file, `root-relative link ${match[0]} breaks under /cavi-maps/; write it relative (./…)`);

// The voice and the offline page say the new name.
if (APP_NAME !== 'Cavi Maps' || APP_BYLINE !== 'by Capline Group') report('lib/brand.mjs', 'brand constants changed');
if (!arrivalPhrase(true).endsWith(`Спасибо, что выбрали ${APP_SPOKEN}`)) report('lib/travel.mjs', `arrival phrase does not thank with «${APP_SPOKEN}»`);
if (!read('public/sw.js').includes(`Нет связи с ${APP_NAME}.`)) report('public/sw.js', `the offline answer does not name ${APP_NAME}`);

const awaiting = [...problems.keys()].filter(file => AWAITING.has(file)), other = [...problems.keys()].filter(file => !AWAITING.has(file));
const print = file => { console.log(`  ${file}`); for (const message of problems.get(file)) console.log(`    ${message}`); };
if (other.length) { console.log('Old brand or broken brand setup:'); other.forEach(print); }
if (awaiting.length) { console.log('Awaiting integration of the brand hooks (shared files, edited later):'); awaiting.forEach(print); }
if (problems.size) {
  console.log(`FAIL: ${other.length ? `${other.length} file(s) to fix` : 'everything else passes'}${awaiting.length ? `; still awaiting integration: ${awaiting.join(', ')}` : ''}. ${files} files scanned.`);
  process.exit(1);
}
console.log(`PASS: ${files} files carry the Cavi Maps name and none shows the old one; title, manifest, icons, favicon/CaviMark drawing, relative static links, voice and offline texts agree.`);

import {SITE_ROOT, siteUrl} from './site-url';
export function readMapUrl(path = location.pathname) {
  const relative = path.startsWith(SITE_ROOT) ? path.slice(SITE_ROOT.length) : path;
  const match = /^Capline-Group\/Maps\/Tajikistan\/[^/]+\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\/?$/.exec(relative);
  if (!match) return null;
  const lat = Number(match[1]), lon = Number(match[2]);
  if (lat < 35.5 || lat > 42 || lon < 66 || lon > 76.5) return null;
  const z = Number(new URLSearchParams(location.search).get('z') || 16);
  return {center: [lon, lat] as [number, number], zoom: Math.max(4, Math.min(20, Number.isFinite(z) ? z : 16))};
}
const citySlug: Record<string, string> = {'Душанбе':'Dushanbe','Худжанд':'Khujand','Шайдон':'Shaydon','Таджикистан':'Tajikistan'};
export function mapPath(lat: number, lon: number, city: string) {
  return siteUrl(`/Capline-Group/Maps/Tajikistan/${encodeURIComponent(citySlug[city] || city)}/${lat.toFixed(6)},${lon.toFixed(6)}`);
}

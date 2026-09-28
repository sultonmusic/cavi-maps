/** Where the site is served: '/' on Firebase, '/cavi-maps/' on GitHub Pages (set by the build's `base`).
 * Turns a site path such as '/places.json' into a URL under that root. */
export const SITE_ROOT = (import.meta as ImportMeta & { env: { BASE_URL: string } }).env.BASE_URL
export const siteUrl = (path: string) => SITE_ROOT + path.replace(/^\//, '')

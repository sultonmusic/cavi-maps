// The platform's name and byline in one place. Imported by the map, the admin panel, the voice
// prompts and the Node checks, so it stays plain JavaScript with no browser globals.
// Internal names keep the old "atlas" spelling on purpose: localStorage keys (atlas-*), tag keys
// (atlas:*), the service-worker cache prefix, folder names and the 'Atlas Local CA' certificate.

export const APP_NAME = 'Cavi Maps';
export const APP_COMPANY = 'Capline Group';
export const APP_BYLINE = 'by Capline Group';
export const APP_TITLE = 'Cavi Maps — карта Таджикистана';
/** document.title of the admin panel. */
export const APP_ADMIN_TITLE = 'Cavi Maps — управление картой';
export const APP_DESCRIPTION = 'Карта Таджикистана с 3D-домами, поиском мест, улиц и дорог, маршрутами и навигатором. Работает без интернета.';
/** How a Russian voice should say the name. */
export const APP_SPOKEN = 'Кави Мапс';
/** The brand green: the mark's tile, theme-color and the primary buttons. */
export const APP_COLOR = '#00866a';
/** Shown in the About sheet and the Profile footer. Bump it with a user-visible release. */
export const APP_VERSION = '2026.09.29';

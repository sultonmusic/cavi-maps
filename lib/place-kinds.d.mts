export type ChipId = 'all' | 'food' | 'shop' | 'hotel' | 'health' | 'fuel' | 'bank' | 'transport' | 'edu' | 'tourism';
type Tags = Record<string, string> | null | undefined;
export const CHIPS: readonly (readonly [ChipId, string])[];
export const PLACE_KIND_LABELS: Record<string, string>;
export const BUSINESS_LABELS: Record<string, string>;
/** key 'amenity=pharmacy' → [label, chip ('' when only under «Все»), synonyms]. */
export const KINDS: Readonly<Record<string, readonly [string, ChipId | '', readonly string[]]>>;
export function kindKey(tags: Tags): string;
export function kindLabel(tags: Tags): string;
export function kindWords(tags: Tags): string[];
export function chipOf(tags: Tags): ChipId;
export function focusZoom(tags: Tags): number;

/** The Cavi Maps mark: a white "C" with a location dot in its opening, on the brand-green tile.
    public/favicon.svg and the PWA icons are drawn from the same 64-unit grid by
    scripts/make-app-icons.py; scripts/check-brand.mjs keeps the three identical.

    variant 'tile' (default) draws the green rounded tile. variant 'glyph' draws only the C and the
    dot in currentColor on a transparent box, for a place that already paints the green square
    itself (the admin logo and login badge). Pass `title` when the mark stands alone and should be
    read out; otherwise it is decorative and hidden from screen readers. */
type Props = {size?: number | string; className?: string; variant?: 'tile' | 'glyph'; title?: string};

export default function CaviMark({size = 28, className = 'cavi-mark', variant = 'tile', title}: Props) {
  const glyph = variant === 'glyph';
  const ink = glyph ? 'currentColor' : '#fff';
  return <svg className={className} width={size} height={size} viewBox={glyph ? '12 12 40 40' : '0 0 64 64'}
    role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
    {!glyph && <rect width="64" height="64" rx="14" fill="#00866a"/>}
    <path d="M41.2 21.22A14.5 14.5 0 1 0 41.2 42.78" fill="none" stroke={ink} strokeWidth="7.5" strokeLinecap="round"/>
    <circle cx="46" cy="32" r="5.25" fill={ink}/>
  </svg>;
}

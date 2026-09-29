"""Draw the Cavi Maps mark: a white "C" with a location dot on a brand-green rounded tile.

Writes, into the folder given as the first argument (default: public/ next to this script):
  favicon.svg            the mark as SVG (also the tab icon)
  icon-192.png           PWA icon, rounded tile with transparent corners
  icon-512.png           PWA icon, rounded tile with transparent corners
  icon-maskable-512.png  full-bleed square for Android masks and the iOS home screen
                         (iOS paints transparent corners black, so it gets the opaque one)

    python scripts/make-app-icons.py [out-dir] [--preview preview.png]

The geometry is on a 64-unit grid and must stay equal to components/cavi-mark.tsx;
node scripts/check-brand.mjs compares the two. Pillow only, well under 100 MB of memory.
"""
import math
import os
import sys

from PIL import Image, ImageDraw

GREEN = (0, 134, 106)  # #00866a, the APP_COLOR of lib/brand.mjs
WHITE = (255, 255, 255)

# 64-unit grid, y down. Keep equal to components/cavi-mark.tsx.
TILE_RADIUS = 14      # corner radius of the tile
C_X, C_Y = 31.5, 32   # centre of the "C"
C_R = 14.5            # radius of the stroke's centre line
C_W = 7.5             # stroke width, round caps
GAP = 48              # half-angle of the opening, degrees either side of 3 o'clock
DOT_X, DOT_Y, DOT_R = 46, 32, 5.25  # the location dot, on the stroke's centre line in the opening
MASKABLE_SCALE = 0.72  # glyph size on the full-bleed icon: inside the 80% maskable safe circle


def fmt(value):
    text = f'{value:.2f}'.rstrip('0').rstrip('.')
    return text if text != '-0' else '0'


def c_ends():
    a = math.radians(GAP)
    return (C_X + C_R * math.cos(a), C_Y - C_R * math.sin(a)), (C_X + C_R * math.cos(a), C_Y + C_R * math.sin(a))


def c_path():
    """SVG path of the C: from the upper end, counter-clockwise round the left side to the lower end."""
    (x0, y0), (x1, y1) = c_ends()
    return f'M{fmt(x0)} {fmt(y0)}A{fmt(C_R)} {fmt(C_R)} 0 1 0 {fmt(x1)} {fmt(y1)}'


def svg():
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
            '<title>Cavi Maps</title>'
            f'<rect width="64" height="64" rx="{fmt(TILE_RADIUS)}" fill="#00866a"/>'
            f'<path d="{c_path()}" fill="none" stroke="#fff" stroke-width="{fmt(C_W)}" stroke-linecap="round"/>'
            f'<circle cx="{fmt(DOT_X)}" cy="{fmt(DOT_Y)}" r="{fmt(DOT_R)}" fill="#fff"/>'
            '</svg>\n')


def draw_glyph(draw, unit, ox, oy, scale=1.0):
    """The white C and dot. `unit` is pixels per grid unit; the glyph is scaled about the tile centre."""
    def at(x, y):
        return ox + (32 + (x - 32) * scale) * unit, oy + (32 + (y - 32) * scale) * unit

    outer, inner = (C_R + C_W / 2) * scale * unit, (C_R - C_W / 2) * scale * unit
    cx, cy = at(C_X, C_Y)
    steps = 720
    arc = [math.radians(GAP + (360 - 2 * GAP) * i / steps) for i in range(steps + 1)]
    ring = [(cx + outer * math.cos(t), cy + outer * math.sin(t)) for t in arc]
    ring += [(cx + inner * math.cos(t), cy + inner * math.sin(t)) for t in reversed(arc)]
    draw.polygon(ring, fill=WHITE)
    cap = C_W / 2 * scale * unit
    for x, y in c_ends():
        px, py = at(x, y)
        draw.ellipse([px - cap, py - cap, px + cap, py + cap], fill=WHITE)
    dx, dy = at(DOT_X, DOT_Y)
    dot = DOT_R * scale * unit
    draw.ellipse([dx - dot, dy - dot, dx + dot, dy + dot], fill=WHITE)


def icon(size, maskable=False):
    ss = 8 if size <= 256 else 4  # supersampling, then a Lanczos downscale
    big = size * ss
    image = Image.new('RGBA', (big, big), GREEN + (0,))  # green, not black, under the clear corners: no dark fringe
    draw = ImageDraw.Draw(image)
    unit = big / 64
    if maskable:
        draw.rectangle([0, 0, big, big], fill=GREEN)
    else:
        draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=TILE_RADIUS * unit, fill=GREEN)
    draw_glyph(draw, unit, 0, 0, MASKABLE_SCALE if maskable else 1.0)
    image = image.resize((size, size), Image.LANCZOS)
    return image.convert('RGB') if maskable else image


def main():
    args = [a for a in sys.argv[1:]]
    preview = None
    if '--preview' in args:
        i = args.index('--preview')
        preview = args[i + 1]
        del args[i:i + 2]
    out = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'favicon.svg'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(svg())
    written = ['favicon.svg']
    for name, size, maskable in (('icon-192.png', 192, False), ('icon-512.png', 512, False), ('icon-maskable-512.png', 512, True)):
        icon(size, maskable).save(os.path.join(out, name), optimize=True)
        written.append(name)
    if preview:
        # The sizes people actually see, on light and dark backgrounds, for a visual review.
        sizes = [16, 24, 32, 48, 64, 96, 192]
        sheet = Image.new('RGB', (sum(sizes) + 20 * (len(sizes) + 1) + 220, 2 * 212), (255, 255, 255))
        sheet.paste((32, 33, 36), (0, 212, sheet.width, 2 * 212))
        for row in range(2):
            x = 20
            for s in sizes:
                tile = icon(s)
                sheet.paste(tile, (x, row * 212 + 10 + (192 - s) // 2), tile)
                x += s + 20
            masked = icon(512, True).resize((192, 192), Image.LANCZOS)
            circle = Image.new('L', (192 * 4, 192 * 4), 0)
            ImageDraw.Draw(circle).ellipse([0, 0, 192 * 4 - 1, 192 * 4 - 1], fill=255)
            sheet.paste(masked, (x, row * 212 + 10), circle.resize((192, 192), Image.LANCZOS))
        sheet.save(preview)
    print('Cavi Maps icons written to', os.path.normpath(out) + ':', ', '.join(written))


if __name__ == '__main__':
    main()

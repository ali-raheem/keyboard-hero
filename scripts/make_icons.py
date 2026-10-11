#!/usr/bin/env python3
"""Draw the app icons (icon.svg plus the PNG sizes) from one geometry: a highway in
perspective with the four lane gems sitting on the strike line. Pillow only."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / 'icons'
BG = (11, 10, 16)
ROAD = (27, 24, 38)
RAIL = (60, 54, 80)
STRIKE = (255, 179, 71)
GEMS = [(55, 214, 122), (255, 82, 82), (255, 210, 63), (74, 163, 255)]  # the lane colours in css/style.css


def geometry(s, inset):
    """Shapes in a 0..s square; inset shrinks the art for maskable safe zones."""
    m = s * inset
    w = s - 2 * m
    top, bottom = m + w * 0.1, m + w * 0.9
    road = [(m + w * 0.38, top), (m + w * 0.62, top), (m + w * 0.97, bottom), (m + w * 0.03, bottom)]
    rails = []
    for i in range(1, 4):
        f = i / 4
        rails.append(((m + w * (0.38 + 0.24 * f), top), (m + w * (0.03 + 0.94 * f), bottom)))
    y = m + w * 0.72
    left, right = m + w * (0.38 - 0.35 * 0.775), m + w * (0.62 + 0.35 * 0.775)
    lane = (right - left) / 4
    r = lane * 0.36
    gems = [((left + lane * (i + 0.5), y), r, GEMS[i]) for i in range(4)]
    strike = (left, y - w * 0.012, right, y + w * 0.012)
    return road, rails, strike, gems


def png(size, inset, rounded):
    k = 4
    s = size * k
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s * 0.22, fill=BG)
    else:
        d.rectangle((0, 0, s, s), fill=BG)
    road, rails, strike, gems = geometry(s, inset)
    d.polygon(road, fill=ROAD)
    for a, b in rails:
        d.line([a, b], fill=RAIL, width=max(1, int(s * 0.008)))
    d.rectangle(strike, fill=STRIKE)
    for (cx, cy), r, col in gems:
        d.ellipse((cx - r, cy - r * 0.62, cx + r, cy + r * 0.62), fill=col)
        d.ellipse((cx - r * 0.45, cy - r * 0.3, cx + r * 0.45, cy + r * 0.3), fill=(255, 255, 255, 170))
    return img.resize((size, size), Image.LANCZOS)


def svg():
    s = 512
    road, rails, strike, gems = geometry(s, 0)
    hexc = lambda c: '#%02x%02x%02x' % c
    pts = lambda p: ' '.join(f'{x:.1f},{y:.1f}' for x, y in p)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}">',
           f'<rect width="{s}" height="{s}" rx="{s * 0.22:.0f}" fill="{hexc(BG)}"/>',
           f'<polygon points="{pts(road)}" fill="{hexc(ROAD)}"/>']
    for (x1, y1), (x2, y2) in rails:
        out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{hexc(RAIL)}" stroke-width="{s * 0.008:.1f}"/>')
    x0, y0, x1, y1 = strike
    out.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1 - x0:.1f}" height="{y1 - y0:.1f}" fill="{hexc(STRIKE)}"/>')
    for (cx, cy), r, col in gems:
        out.append(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{r:.1f}" ry="{r * 0.62:.1f}" fill="{hexc(col)}"/>')
        out.append(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{r * 0.45:.1f}" ry="{r * 0.3:.1f}" fill="#fff" fill-opacity="0.67"/>')
    out.append('</svg>')
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    ROOT.mkdir(exist_ok=True)
    (ROOT / 'icon.svg').write_text(svg())
    png(192, 0, True).save(ROOT / 'icon-192.png')
    png(512, 0, True).save(ROOT / 'icon-512.png')
    png(512, 0.12, False).save(ROOT / 'icon-maskable-512.png')
    png(180, 0, False).save(ROOT / 'apple-touch-icon.png')
    print('icons written to', ROOT)

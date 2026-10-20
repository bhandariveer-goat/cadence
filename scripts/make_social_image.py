#!/usr/bin/env python3
"""Draw the image a link to Cadence shows when it is shared.

    python3 scripts/make_social_image.py

Writes icons/social.png, 1200 by 630, the size chat apps and social sites ask
for. It is drawn from the same colours and the same mark as the site, flat, on
white: the name, what it is in one line, and a small week with the four kinds
of thing a calendar holds. Nothing in it is a screenshot or a photograph.

This is a tool for whoever maintains the site, not part of the site: it needs
Pillow (pip install pillow) and the macOS system font, and it only has to be
run again if the picture should change. The PNG it writes is committed.
"""
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit('This needs Pillow:  python3 -m pip install pillow')

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'icons' / 'social.png'
W, H, S = 1200, 630, 2          # drawn at twice the size, then scaled down, so edges are smooth

# The site's tokens (site.css).
BG, TEXT, TEXT_2, LINE, LINE_STRONG, SURFACE_2 = '#ffffff', '#1c1b19', '#55514c', '#e7e5e1', '#d4d1cc', '#f7f6f4'
ACCENT = '#f0712b'
K_SCHOOL, K_EVENT, K_ACTIVITY, K_WORK = '#8a857f', '#2563eb', '#16a34a', '#f0712b'

SF = '/System/Library/Fonts/SFNS.ttf'
HELV = '/System/Library/Fonts/HelveticaNeue.ttc'


def font(size, weight='Semibold'):
    """The system font at a weight; Helvetica Neue if this machine has no SF."""
    try:
        f = ImageFont.truetype(SF, size * S)
        f.set_variation_by_name(weight.encode())
        return f
    except (OSError, ValueError):
        return ImageFont.truetype(HELV, size * S, index={'Semibold': 1, 'Bold': 1, 'Medium': 10}.get(weight, 0))


def mix(colour, share, base=BG):
    """colour at `share` over base: the tint a block has on the calendar."""
    c = [int(colour[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(base[i:i + 2], 16) for i in (1, 3, 5)]
    return '#%02x%02x%02x' % tuple(round(c[i] * share + b[i] * (1 - share)) for i in range(3))


# A size in points to pixels at the image's scale (it is drawn large, then shrunk).
def px(v):
    return int(round(v * S))


def mark(d, x, y, size):
    """The Cadence mark: two open rings, white on an orange square."""
    d.rounded_rectangle([px(x), px(y), px(x + size), px(y + size)], radius=px(size * 6 / 28), fill=ACCENT)
    unit = (size * 18 / 28) / 24                       # the glyph is drawn on a 24 grid
    cx, cy = x + size / 2, y + size / 2
    stroke = 2.6 * unit
    for r, end in ((8.5, 197.8), (4, 197.5)):
        box = [px(cx - r * unit), px(cy - r * unit), px(cx + r * unit), px(cy + r * unit)]
        d.arc(box, start=-90, end=end, fill='#ffffff', width=px(stroke))
        # Round ends, which the arc itself does not have.
        import math
        for angle in (-90, end):
            mid = r * unit - stroke / 2
            ex, ey = cx + mid * math.cos(math.radians(angle)), cy + mid * math.sin(math.radians(angle))
            d.ellipse([px(ex - stroke / 2), px(ey - stroke / 2), px(ex + stroke / 2), px(ey + stroke / 2)], fill='#ffffff')


def week(d, x, y, w, h):
    """Five days of a week: school, an event, two activities, planned work."""
    d.rounded_rectangle([px(x), px(y), px(x + w), px(y + h)], radius=px(12), fill=BG, outline=LINE_STRONG, width=px(1))
    head = 44
    d.line([px(x), px(y + head), px(x + w), px(y + head)], fill=LINE, width=px(1))
    days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
    col = w / len(days)
    label = font(15, 'Medium')
    for i, name in enumerate(days):
        left = x + i * col
        if i:
            d.line([px(left), px(y), px(left), px(y + h)], fill=LINE, width=px(1))
        d.text((px(left + col / 2), px(y + head / 2)), name, font=label, fill=TEXT_2, anchor='mm')

    top, bottom = y + head + 12, y + h - 12
    span = bottom - top

    # One block on the little week: a tinted bar with a solid edge.
    def block(day, start, end, colour, share=.16):
        left = x + day * col + 8
        d.rounded_rectangle([px(left), px(top + span * start), px(left + col - 16), px(top + span * end)], radius=px(4), fill=mix(colour, share))
        d.rectangle([px(left), px(top + span * start), px(left + 3), px(top + span * end)], fill=colour)

    for day in range(5):
        block(day, 0, .46, K_SCHOOL, .10)                 # school, every day
    block(0, .50, .64, K_ACTIVITY)                         # practice
    block(2, .50, .64, K_ACTIVITY)
    block(1, .52, .68, K_ACTIVITY)
    block(3, .52, .68, K_ACTIVITY)
    block(4, .34, .44, K_EVENT)                            # an appointment
    block(1, .82, .92, K_EVENT)
    for day, start, end in ((0, .68, .80), (0, .83, .93), (1, .71, .79), (2, .68, .82), (2, .85, .97), (3, .72, .84), (4, .52, .66), (4, .69, .79)):
        block(day, start, end, K_WORK, .18)                # the work, planned around all of it


# Draws the share image (the mark and name, the headline, the line under it and
# a sample week) and saves it.
def main():
    img = Image.new('RGB', (W * S, H * S), BG)
    d = ImageDraw.Draw(img)

    pad = 72
    mark(d, pad, pad, 56)
    d.text((px(pad + 56 + 16), px(pad + 28)), 'Cadence', font=font(34, 'Semibold'), fill=TEXT, anchor='lm')

    headline = font(60, 'Semibold')
    y = 216
    for line in ('The planner that', 'schedules your', 'homework.'):
        d.text((px(pad), px(y)), line, font=headline, fill=TEXT, anchor='ls')
        y += 72
    sub = font(26, 'Regular')
    d.text((px(pad), px(y - 16)), 'Reads Canvas. Plans around school,', font=sub, fill=TEXT_2, anchor='ls')
    d.text((px(pad), px(y + 22)), 'practice and sleep.', font=sub, fill=TEXT_2, anchor='ls')

    week(d, 640, 112, 488, 406)

    legend = font(17, 'Medium')
    lx = 640
    for name, colour in (('School', K_SCHOOL), ('Events', K_EVENT), ('Activities', K_ACTIVITY), ('Planned work', K_WORK)):
        d.rounded_rectangle([px(lx), px(548), px(lx + 12), px(560)], radius=px(3), fill=colour)
        d.text((px(lx + 20), px(554)), name, font=legend, fill=TEXT_2, anchor='lm')
        lx += 20 + d.textlength(name, font=legend) / S + 28

    d.rectangle([0, px(H - 8), px(W), px(H)], fill=ACCENT)

    img.resize((W, H), Image.LANCZOS).save(OUT, optimize=True)
    print(f'wrote {OUT.relative_to(ROOT)}  {W}x{H}  {OUT.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()

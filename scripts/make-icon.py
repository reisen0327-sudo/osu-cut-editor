import math, random, os
from PIL import Image, ImageDraw, ImageFilter

S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))
LOGO_SRC = os.path.join(HERE, '..', 'build', 'osu-logo-source.png')
OUT_PNG = os.path.join(HERE, '..', 'build', 'icon.png')
OUT_ICO = os.path.join(HERE, '..', 'build', 'icon.ico')

# 1. radial dark background
rad = Image.radial_gradient("L").resize((S, S), Image.LANCZOS)
c1 = (43, 16, 85)      # #2b1055 center
c2 = (5, 1, 13)        # #05010d edge
bg1 = Image.new("RGB", (S, S), c1)
bg2 = Image.new("RGB", (S, S), c2)
bg = Image.composite(bg1, bg2, rad).convert("RGBA")

# 2. paste official logo
logo = Image.open(LOGO_SRC).convert("RGBA")
LOGO = 620
logo = logo.resize((LOGO, LOGO), Image.LANCZOS)
cx = (S - LOGO) // 2
cy = (S - LOGO) // 2

# 3. slash geometry (bottom-left -> top-right)
x1, y1 = 150, 874
x2, y2 = 874, 150
dx, dy = x2 - x1, y2 - y1
length = math.hypot(dx, dy)
ux, uy = dx / length, dy / length
# normal (perpendicular)
nx, ny = -uy, ux
gap = 34.0
offset = 11.0

def line_intersection(a1, a2, b1, b2):
    # infinite line through a1/a2 with the segment b1/b2; returns point inside segment or None
    x1, y1 = a1
    x2, y2 = a2
    x3, y3 = b1
    x4, y4 = b2
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(den) < 1e-9:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    px = x1 + t * (x2 - x1)
    py = y1 + t * (y2 - y1)
    if min(x3, x4) - 1e-6 <= px <= max(x3, x4) + 1e-6 and min(y3, y4) - 1e-6 <= py <= max(y3, y4) + 1e-6:
        return (px, py)
    return None


def side_mask(shift, keep_top_left):
    lx1 = x1 + nx * shift
    ly1 = y1 + ny * shift
    lx2 = x2 + nx * shift
    ly2 = y2 + ny * shift
    ex = ux * 2000
    ey = uy * 2000
    l1 = (lx1 - ex, ly1 - ey)
    l2 = (lx2 + ex, ly2 + ey)

    def side(px, py):
        return (px - lx1) * (ly2 - ly1) - (py - ly1) * (lx2 - lx1)

    edges = [
        ((0, 0), (S, 0)),
        ((S, 0), (S, S)),
        ((S, S), (0, S)),
        ((0, S), (0, 0)),
    ]
    pts = []
    for b1, b2 in edges:
        p = line_intersection(l1, l2, b1, b2)
        if p is not None:
            pts.append(p)
    corners = [(0, 0), (S, 0), (S, S), (0, S)]
    for c in corners:
        if (side(c[0], c[1]) <= 0) == keep_top_left:
            pts.append(c)
    # deduplicate
    uniq = []
    for p in pts:
        if not any((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < 1e-6 for q in uniq):
            uniq.append(p)
    if len(uniq) < 3:
        raise RuntimeError("icon split mask degenerated")
    cx = sum(p[0] for p in uniq) / len(uniq)
    cy = sum(p[1] for p in uniq) / len(uniq)
    uniq.sort(key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).polygon(uniq, fill=255)
    return m


mask_top_left = side_mask(gap / 2, True)
mask_bottom_right = side_mask(-gap / 2, False)

half_a = Image.new("RGBA", (S, S), (0, 0, 0, 0))
half_b = Image.new("RGBA", (S, S), (0, 0, 0, 0))
half_a.paste(logo, (cx, cy), logo)
half_b.paste(logo, (cx, cy), logo)

zero = Image.new("L", (S, S), 0)
alpha_a = Image.composite(half_a.split()[3], zero, mask_top_left)
half_a.putalpha(alpha_a)
alpha_b = Image.composite(half_b.split()[3], zero, mask_bottom_right)
half_b.putalpha(alpha_b)

# offset the halves along normal (top-left half moves with +normal, bottom-right with -normal)
oa = (round(nx * offset), round(ny * offset))
ob = (-round(nx * offset), -round(ny * offset))
bg.paste(half_a, oa, half_a)
bg.paste(half_b, ob, half_b)

# verification stats: pink pixels on both sides of the slash line
ver_a = 0
ver_b = 0
for y in range(0, S, 4):
    for x in range(0, S, 4):
        r, g, b, a = bg.getpixel((x, y))
        if a < 60 or abs(r - 255) > 70 or abs(g - 102) > 70 or abs(b - 170) > 70:
            continue
        side_val = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)
        if side_val <= 0:
            ver_a += 1
        else:
            ver_b += 1
print('split_verification top_left_pink=%d bottom_right_pink=%d' % (ver_a, ver_b))
if ver_a < 10 or ver_b < 10:
    raise RuntimeError('icon split verification failed: one half is missing')

# 4. blade glow overlay
blade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(blade)
# tapered trail points beyond ends
tip1 = (x1 - ux * 180, y1 - uy * 180)
tip2 = (x2 + ux * 180, y2 + uy * 180)
layers = [
    (tip1, tip2, 72, (255, 102, 170, 46)),
    (tip1, tip2, 48, (125, 249, 255, 80)),
    (tip1, tip2, 30, (255, 255, 255, 150)),
    (tip1, tip2, 16, (255, 255, 255, 235)),
    (tip1, tip2, 6,  (255, 255, 255, 255)),
]
for a, b, w, col in layers:
    bd.line([a, b], fill=col, width=w)
blade = blade.filter(ImageFilter.GaussianBlur(6))
bg = Image.alpha_composite(bg, blade)

# 5. sparks (fixed seed)
rnd = random.Random(42)
spark = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(spark)
for _ in range(90):
    t = rnd.random()
    px = x1 + ux * length * t + nx * rnd.uniform(-60, 60)
    py = y1 + uy * length * t + ny * rnd.uniform(-60, 60)
    r = rnd.uniform(1.5, 5.5)
    alpha = rnd.randint(90, 220)
    sd.ellipse([px - r, py - r, px + r, py + r], fill=(255, 255, 255, alpha))
spark = spark.filter(ImageFilter.GaussianBlur(0.6))
bg = Image.alpha_composite(bg, spark)

# 6. edge highlight along the cut
edge = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ed = ImageDraw.Draw(edge)
ed.line([(x1, y1), (x2, y2)], fill=(255, 255, 255, 200), width=3)
edge = edge.filter(ImageFilter.GaussianBlur(0.4))
bg = Image.alpha_composite(bg, edge)

os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
icon256 = bg.resize((256, 256), Image.LANCZOS)
icon256.save(OUT_PNG)
icon256.save(OUT_ICO, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("PNG", OUT_PNG, icon256.size, os.path.getsize(OUT_PNG))
print("ICO", OUT_ICO, os.path.getsize(OUT_ICO))

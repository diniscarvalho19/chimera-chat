"""
Adds the Latin accented letters (àáâãäåçèéêëìíîïñòóôõöùúûüýÿ and capitals) to AVHershey Simplex,
which has only ASCII: without them the browser draws "ção" in the next font, filled and bold.
Each is its base letter plus an accent drawn in the font's own stroke (width, round ends). Letters
the font already has are skipped, so running it again changes nothing.

    python3 -m pip install fonttools && python3 tools/hershey-accents.py
"""
import math
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parent.parent / "public" / "fonts"

# accent strokes (polylines) around (0, 0): the centre of the letter, at the accent's foot
ACCENTS = {
    "grave": [[(30, 0), (-30, 90)]],
    "acute": [[(-30, 0), (30, 90)]],
    "circumflex": [[(-55, 0), (0, 80), (55, 0)]],
    "tilde": [[(-75 + 150 * i / 12, 25 * math.sin(math.pi * 2 * i / 12) + 30) for i in range(13)]],
    "dieresis": "dots",
    "ring": [[(40 * math.sin(2 * math.pi * i / 16), 45 - 40 * math.cos(2 * math.pi * i / 16)) for i in range(17)]],
}
MARKS = {"̀": "grave", "́": "acute", "̂": "circumflex", "̃": "tilde", "̈": "dieresis", "̊": "ring"}
LETTERS = "àáâãäåèéêëìíîïñòóôõöùúûüýÿÀÁÂÃÄÅÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ"
# a cedilla: a hook under the letter (from its foot, y = 0)
CEDILLA = [(0, 0), (0, -45), (35, -60), (40, -95), (-25, -120)]


def capsule(pen, a, b, r):
    """a stroke from a to b, round ends of radius r (counter-clockwise, as the font's own)"""
    (x0, y0), (x1, y1) = a, b
    ang = math.atan2(y1 - y0, x1 - x0)
    pts = []
    for i in range(9):  # round end at b, then at a
        t = ang - math.pi / 2 + math.pi * i / 8
        pts.append((x1 + r * math.cos(t), y1 + r * math.sin(t)))
    for i in range(9):
        t = ang + math.pi / 2 + math.pi * i / 8
        pts.append((x0 + r * math.cos(t), y0 + r * math.sin(t)))
    pen.moveTo(tuple(round(v) for v in pts[0]))
    for p in pts[1:]:
        pen.lineTo(tuple(round(v) for v in p))
    pen.closePath()


def main():
    import unicodedata

    for path in sorted(FONTS.glob("AVHersheySimplex*.otf")):
        f = TTFont(path)
        cmap = f.getBestCmap()
        gs = f.getGlyphSet()
        cff = f["CFF "].cff
        top = cff.topDictIndex[0]
        cs = top.CharStrings

        def bounds(name):
            b = BoundsPen(gs)
            gs[name].draw(b)
            return b.bounds

        stem = bounds(cmap[ord("l")])
        w = stem[2] - stem[0]  # the stroke's width
        dot = bounds(cmap[ord(".")])
        r_dot = (dot[2] - dot[0]) / 2
        added = []
        for ch in LETTERS + "çÇ":
            if ord(ch) in cmap:
                continue
            base_ch, *marks = unicodedata.normalize("NFD", ch)
            base = cmap[ord(base_ch)]
            adv = f["hmtx"][base][0]
            x0, y0, x1, y1 = bounds(base)
            cx = (x0 + x1) / 2
            pen = T2CharStringPen(adv, gs)
            if base_ch == "i":  # dotless: the stem alone
                capsule(pen, (cx, 0), (cx, 407), w / 2)
                y1 = 407
            else:
                gs[base].draw(pen)
            foot = y1 + 90  # the accent's foot, above the letter
            for m in (m for m in marks if m in MARKS):  # a cedilla is drawn below
                kind = ACCENTS[MARKS[m]]
                if kind == "dots":
                    for dx in (-45, 45):
                        capsule(pen, (cx + dx, foot + 30), (cx + dx, foot + 30), r_dot)
                    continue
                for line in kind:
                    pts = [(cx + x, foot + y) for x, y in line]
                    for a, b in zip(pts, pts[1:]):
                        capsule(pen, a, b, w / 2)
            if base_ch in "cC":
                pts = [(cx + x, y) for x, y in CEDILLA]
                for a, b in zip(pts, pts[1:]):
                    capsule(pen, a, b, w / 2)
            name = f"uni{ord(ch):04X}"
            charstring = pen.getCharString(private=top.Private, globalSubrs=cff.GlobalSubrs)
            if cs.charStringsAreIndexed:
                cs.charStringsIndex.append(charstring)
                cs.charStrings[name] = len(cs.charStringsIndex) - 1
            else:
                cs.charStrings[name] = charstring
            top.charset.append(name)  # the font's glyph order too: the same list
            f["hmtx"][name] = (adv, f["hmtx"][base][1])
            for t in f["cmap"].tables:
                if t.isUnicode():
                    t.cmap[ord(ch)] = name
            added.append(ch)
        f.save(path)
        print(path.name, "added", "".join(added) or "nothing")


main()

#!/usr/bin/env python3
"""Build the printable forms at /forms from the book's print interior.

    python3 tools/build-forms.py path/to/KDP_PRINT_INTERIOR_SPREAD.pdf

When Your Mind and Money Collide promises readers PDF copies of every form at
jeffreypotts.ca/Forms. This cuts each form listed in src/data/forms.json out
of the print-interior PDF (two 8.5 x 11 pages per sheet, side by side) and
writes forms/<file>.pdf, plus one PDF with every form in book order. Each page
gets a small line at the foot naming the book and the forms page.

Run it after changing src/data/forms.json or the book's interior, and commit
the results. macOS only: it uses Quartz (PyObjC), which the system Python has.
"""

import json
import sys
from pathlib import Path

import Quartz
from AppKit import NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSGraphicsContext, NSString
from Foundation import NSURL

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "src" / "data" / "forms.json"

PAGE = Quartz.CGRectMake(0, 0, 612, 792)  # 8.5 x 11 in
# Where each page sits on a 1352 x 864 sheet: 36 pt of crop-mark margin,
# then the left page, a 56 pt gutter, and the right page.
LEFT_X, RIGHT_X, MARGIN_Y = 36, 704, 36
FOOTER = "From When Your Mind and Money Collide: Canada by Jeffrey Potts  ·  More forms: jeffreypotts.ca/forms"


def page_in_sheet(doc, n):
    """The sheet holding book-file page n (1-based) and the page's x offset."""
    sheet = Quartz.CGPDFDocumentGetPage(doc, (n + 1) // 2)
    return sheet, LEFT_X if n % 2 == 1 else RIGHT_X


def draw_footer(ctx):
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.setCurrentContext_(NSGraphicsContext.graphicsContextWithCGContext_flipped_(ctx, False))
    attrs = {NSFontAttributeName: NSFont.systemFontOfSize_(7), NSForegroundColorAttributeName: NSColor.grayColor()}
    NSString.stringWithString_(FOOTER).drawAtPoint_withAttributes_((36, 14), attrs)
    NSGraphicsContext.restoreGraphicsState()


def write_pdf(doc, pages, out, title):
    info = {Quartz.kCGPDFContextTitle: title, Quartz.kCGPDFContextAuthor: "Jeffrey Potts"}
    ctx = Quartz.CGPDFContextCreateWithURL(NSURL.fileURLWithPath_(str(out)), PAGE, info)
    for n in pages:
        sheet, x = page_in_sheet(doc, n)
        Quartz.CGContextBeginPage(ctx, PAGE)
        Quartz.CGContextSaveGState(ctx)
        Quartz.CGContextClipToRect(ctx, PAGE)
        Quartz.CGContextTranslateCTM(ctx, -x, -MARGIN_Y)
        Quartz.CGContextDrawPDFPage(ctx, sheet)
        Quartz.CGContextRestoreGState(ctx)
        draw_footer(ctx)
        Quartz.CGContextEndPage(ctx)
    Quartz.CGPDFContextClose(ctx)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    doc = Quartz.CGPDFDocumentCreateWithURL(NSURL.fileURLWithPath_(sys.argv[1]))
    if doc is None:
        sys.exit(f"Couldn't open {sys.argv[1]}")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    out_dir = ROOT / "forms"
    out_dir.mkdir(exist_ok=True)
    for old in out_dir.glob("*.pdf"):
        old.unlink()

    every = []
    for f in manifest["forms"]:
        out = ROOT / f["file"].lstrip("/")
        write_pdf(doc, f["sourcePages"], out, f"{f['title']} — When Your Mind and Money Collide")
        every += f["sourcePages"]
    write_pdf(doc, every, ROOT / manifest["all"].lstrip("/"), "Every form — When Your Mind and Money Collide")

    total = sum(p.stat().st_size for p in out_dir.glob("*.pdf"))
    print(f"Wrote {len(manifest['forms'])} forms and the combined PDF to forms/ ({total // 1024} KB)")


if __name__ == "__main__":
    main()

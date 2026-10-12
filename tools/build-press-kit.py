#!/usr/bin/env python3
"""Build press/jeffrey-potts-press-kit.zip, the /press page's one download.

    python3 tools/build-press-kit.py

It holds both bios as text (from src/data/press.json), the headshot, and
every book cover listed in src/lib/books.js. Rebuild and commit the zip
whenever a bio, the headshot or a cover changes.

Every file gets the same fixed timestamp, so rebuilding with nothing changed
gives a byte-identical zip and no spurious change in git.
"""

import json
import re
import sys
import textwrap
import zipfile
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "press" / "jeffrey-potts-press-kit.zip"
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def site_file(url_path):
    return ROOT / unquote(url_path.lstrip("/"))


def covers():
    # Each book's title and cover JPG, from the BOOKS list in src/lib/books.js.
    src = (ROOT / "src" / "lib" / "books.js").read_text(encoding="utf-8")
    books = re.findall(r'title: "([^"]+)",.*?jpg: "([^"]+)"', src, re.S)
    if not books:
        sys.exit("Couldn't read the books in src/lib/books.js; update this script.")
    return books


def bios_text(press):
    wrap = lambda p: textwrap.fill(p, 76)
    return "\n".join(
        [
            f"{press['name'].upper()}: BIOS",
            "",
            "SHORT BIO",
            "",
            wrap(press["shortBio"]),
            "",
            "LONG BIO",
            "",
            "\n\n".join(wrap(p) for p in press["longBio"]),
            "",
            "Photo, covers and the latest: https://jeffreypotts.ca/press",
            "Get in touch: https://jeffreypotts.ca/#contact",
            "",
        ]
    )


def add(z, arcname, data):
    info = zipfile.ZipInfo(arcname, FIXED_TIME)
    info.external_attr = 0o644 << 16
    # Images are already compressed; storing them keeps the build quick.
    info.compress_type = zipfile.ZIP_DEFLATED if arcname.endswith(".txt") else zipfile.ZIP_STORED
    z.writestr(info, data)


def main():
    press = json.loads((ROOT / "src" / "data" / "press.json").read_text(encoding="utf-8"))
    headshot = site_file(press["headshot"]["jpg"])
    books = covers()
    OUT.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUT, "w") as z:
        add(z, "jeffrey-potts-press-kit/bios.txt", bios_text(press).encode("utf-8"))
        add(z, "jeffrey-potts-press-kit/jeffrey-potts-headshot.jpg", headshot.read_bytes())
        for title, jpg in books:
            name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
            add(z, f"jeffrey-potts-press-kit/covers/{name}.jpg", site_file(jpg).read_bytes())
    size = OUT.stat().st_size / 1_000_000
    print(f"Wrote {OUT.relative_to(ROOT)}: bios, headshot, {len(books)} covers; {size:.1f} MB")


if __name__ == "__main__":
    main()

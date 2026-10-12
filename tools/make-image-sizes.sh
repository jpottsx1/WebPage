#!/bin/bash
# Smaller copies of the book covers and the home page portrait, so phones and
# small cards don't download an 800-pixel image to show it at 300.
#
#   tools/make-image-sizes.sh
#
# Writes Books/<name>-320.webp, -480.webp and -640.webp next to each cover's
# WebP, and jeffreypotts-480.webp and -720.webp next to the portrait. The
# pages list them in srcset (src/lib/books.js, index.html), so run this
# after adding or replacing a cover, and commit the results. Needs cwebp
# (brew install webp). Re-running is harmless: it rebuilds every copy.

set -euo pipefail
cd "$(dirname "$0")/.."
command -v cwebp >/dev/null || { echo "cwebp not found: brew install webp" >&2; exit 1; }

resize() { # source width output
  cwebp -quiet -q 80 -resize "$2" 0 "$1" -o "$3"
  echo "  $3 ($(( $(stat -f%z "$3") / 1024 )) KB)"
}

for src in Books/*.webp; do
  case "$src" in *-[0-9][0-9][0-9].webp) continue ;; esac
  base="${src%.webp}"
  for w in 320 480 640; do resize "$src" "$w" "$base-$w.webp"; done
done

for w in 480 720; do resize jeffreypotts.webp "$w" "jeffreypotts-$w.webp"; done

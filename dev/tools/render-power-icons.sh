#!/usr/bin/env bash
# Rasterize editable power-menu SVGs with the existing native icon renderer.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
renderer=${KOYA_ICON_RENDERER:-$root/build/koya-render-icon}
[[ -x "$renderer" ]] || { printf 'Build koya-render-icon or set KOYA_ICON_RENDERER.\n' >&2; exit 1; }
for source in "$root"/assets/power-menu/*.svg; do
    "$renderer" "$source" "${source%.svg}.png"
done

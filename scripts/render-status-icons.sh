#!/bin/sh
# Rebuild editable status SVGs and the PNG textures Koya consumes.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
icons="$root/assets/status"
mkdir -p "$icons"
cream='#F4E9D8'
muted='#59645D'
orange='#D96A1D'
for level in 0 1 2 3 off; do
    outer=$muted middle=$muted inner=$muted dot=$cream
    case "$level" in
        3) outer=$cream middle=$cream inner=$cream;;
        2) middle=$cream inner=$cream;;
        1) inner=$cream;;
        off) dot=$muted;;
    esac
    cat >"$icons/wifi-$level.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round">
<path d="M3 7.5a14 14 0 0 1 18 0" stroke="$outer"/><path d="M6 11.5a9 9 0 0 1 12 0" stroke="$middle"/><path d="M9 15.5a4.6 4.6 0 0 1 6 0" stroke="$inner"/><circle cx="12" cy="19" r="1.2" fill="$dot" stroke="none"/>
EOF
    [ "$level" != off ] || printf '%s\n' '<path d="m4 3 16 18" stroke="#59645D" stroke-width="1.8"/>' >>"$icons/wifi-$level.svg"
    printf '%s\n' '</svg>' >>"$icons/wifi-$level.svg"
done
for level in 0 1 2 3 4 off; do
    printf '%s\n' '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 24 24">' >"$icons/cell-$level.svg"
    for bar in 1 2 3 4; do
        colour=$muted
        if [ "$level" != off ] && [ "$bar" -le "$level" ]; then colour=$cream; fi
        x=$((bar * 5 - 3)) height=$((bar * 4)) y=$((21 - height))
        printf '<rect x="%s" y="%s" width="3" height="%s" rx="1" fill="%s"/>\n' "$x" "$y" "$height" "$colour" >>"$icons/cell-$level.svg"
    done
    [ "$level" != off ] || printf '%s\n' '<path d="m3 3 18 19" fill="none" stroke="#59645D" stroke-width="1.8" stroke-linecap="round"/>' >>"$icons/cell-$level.svg"
    printf '%s\n' '</svg>' >>"$icons/cell-$level.svg"
done
for level in 0 1 2 3 4 5 6 7 8 9 10 unknown; do
    cat >"$icons/battery-$level.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 24 24" fill="none">
<rect x="1.5" y="6.5" width="18.5" height="11" rx="2" stroke="$cream" stroke-width="1.6"/><path d="M22 10v4" stroke="$cream" stroke-width="1.8" stroke-linecap="round"/>
EOF
    if [ "$level" = unknown ]; then
        printf '<path d="M8 12h5" stroke="%s" stroke-width="1.8" stroke-linecap="round"/>\n' "$muted" >>"$icons/battery-$level.svg"
    else
        width=$(awk -v level="$level" 'BEGIN { printf "%.1f", 14.5 * level / 10 }')
        colour=$cream
        [ "$level" -gt 2 ] || colour=$orange
        printf '<rect x="3.5" y="8.5" width="%s" height="7" rx="0.7" fill="%s"/>\n' "$width" "$colour" >>"$icons/battery-$level.svg"
    fi
    printf '%s\n' '</svg>' >>"$icons/battery-$level.svg"
done
cat >"$icons/charging.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 24 24"><path d="m13.5 4-7 9h5l-1 7 7-10h-5Z" fill="$orange" stroke="#000" stroke-width="0.6" stroke-linejoin="round"/></svg>
EOF
cat >"$icons/ethernet.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 24 24" fill="none" stroke="$cream" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v10h-4v4H9v-4H5Z"/><path d="M8 5v4m4-4v4m4-4v4"/></svg>
EOF
for source in "$icons"/*.svg; do
    "$root/build/koya-render-icon" "$source" "${source%.svg}.png"
done

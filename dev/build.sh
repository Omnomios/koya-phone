#!/usr/bin/env bash
# Compile the development environment independently of the phone build.
set -euo pipefail
dev=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
build=$(realpath -m -- "${1:-$dev/.build/host}")
setup=(meson setup "$build" "$dev")
[[ ! -f "$build/meson-private/coredata.dat" ]] || setup+=(--reconfigure)
"${setup[@]}"
meson compile -C "$build"

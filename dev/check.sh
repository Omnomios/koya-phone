#!/usr/bin/env bash
set -euo pipefail
dev=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
build=$(realpath -m -- "${1:-$dev/.build/host}")
bash "$dev/build.sh" "$build"
meson test -C "$build" --print-errorlogs

#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
script="apps/$1.js"
[ "$1" != power-menu ] || script=tests/capture-power-menu.js
[ "$1" != lock-screen ] || script=tests/capture-lock-screen.js
exec "${KOYA_BIN:-/usr/bin/koya}" -n "$KOYA_TEST_BUILD/native/modules" -m "${KOYA_ASSET_DIR:-/usr/share/koya/assets}" -m "$PWD" -i "$script"

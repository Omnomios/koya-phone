#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
script="apps/$1.js"
[ "$1" != power-menu ] || script=tests/capture-power-menu.js
[ "$1" != lock-screen ] || script=tests/capture-lock-screen.js
exec /usr/bin/koya -n /usr/lib -m /usr/share/koya/assets -m "$PWD" -i "$script"

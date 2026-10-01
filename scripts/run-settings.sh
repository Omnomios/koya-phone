#!/bin/sh
set -eu
shell_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$shell_dir"
exec /usr/bin/koya -n "$shell_dir/build/native/modules" -m /usr/share/koya/assets -m "$shell_dir" -i apps/settings.js

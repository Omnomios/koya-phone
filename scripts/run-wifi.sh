#!/bin/sh
set -eu
shell_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$shell_dir"
# This app sends credentials; keep optional native wire tracing disabled.
unset KOYA_DBUS_DEBUG
exec /usr/bin/koya -n /usr/lib -m /usr/share/koya/assets -m "$shell_dir" -i apps/wifi.js

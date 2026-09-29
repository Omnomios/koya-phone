#!/usr/bin/env bash
set -euo pipefail
exec dbus-daemon --address="unix:path=$XDG_RUNTIME_DIR/bus" "$@"

#!/bin/sh
set -eu
shell_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${XDG_RUNTIME_DIR:?Run from the graphical session}"
: "${WAYLAND_DISPLAY:?Run from the compositor session}"
: "${DBUS_SESSION_BUS_ADDRESS:?The compositor must run inside dbus-run-session}"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/koya-shell"
mkdir -p "$state_dir"
# The coordinator owns the singleton lock, child lifetimes and bounded retries.
# Exec preserves the display adapter's parent relationship; no orphan retry loop.
exec setpriv --pdeathsig TERM "$shell_dir/build/koya-session" "$shell_dir" >>"$state_dir/session.log" 2>&1

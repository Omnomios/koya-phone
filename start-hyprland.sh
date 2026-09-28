#!/bin/sh
# Koya phone shell session, launched by tinydm inside D-Bus.
set -eu
: "${DBUS_SESSION_BUS_ADDRESS:?Launch this through the tinydm session}"
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=Hyprland
# Keep the compositor tied to the graphical login and hold one session lock.
XDG_RUNTIME_DIR=/tmp/$(id -u)-runtime-dir
export XDG_RUNTIME_DIR
umask 077
mkdir -p "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"
exec 9>"$XDG_RUNTIME_DIR/koya-compositor.lock"
if ! flock -n 9; then
    echo 'A phone compositor session is already running for this user.' >&2
    exit 1
fi
# Also reject a live shell started by an earlier version of the session wrapper.
for component_lock in koya-hyprland-bridge.lock koya-shell.lock; do
    if [ -f "$XDG_RUNTIME_DIR/$component_lock" ] &&
        ! flock -n "$XDG_RUNTIME_DIR/$component_lock" true; then
        echo 'A phone shell session is already running for this user.' >&2
        exit 1
    fi
done
unset DISPLAY WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE
exec setpriv --pdeathsig TERM Hyprland --config /etc/koya-shell/hyprland.conf "$@"

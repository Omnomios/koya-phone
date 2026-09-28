#!/bin/sh
# Hyprland exec-once entry point. The adapter owns the coordinator lifetime.
set -eu
shell_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/koya-shell"
umask 077
mkdir -p "$state_dir"
exec "$shell_dir/build/koya-hyprland-display" "$shell_dir" >>"$state_dir/hyprland-display.log" 2>&1

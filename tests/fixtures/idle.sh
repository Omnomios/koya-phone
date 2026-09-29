#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" >"$XDG_RUNTIME_DIR/idle-pid"
seconds=${@: -2:1}
command=${@: -1}
timer=
arm() { [[ -z $timer ]] || kill "$timer" 2>/dev/null || true; sleep "$seconds" & timer=$!; }
trap arm USR2
trap '[[ -z $timer ]] || kill "$timer" 2>/dev/null || true; exit' TERM INT
arm
while true; do
  if wait "$timer"; then bash -c "$command"; timer=; fi
  # Stay alive after the timeout, as swayidle does, until rearmed or stopped.
  if [[ -z $timer ]]; then sleep 86400 & timer=$!; fi
done

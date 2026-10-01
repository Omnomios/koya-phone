#!/usr/bin/env bash
set -euo pipefail
fixture=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
instance=$XDG_RUNTIME_DIR/hypr/test
mkdir -p "$instance"
printf '1\n' >"$XDG_RUNTIME_DIR/dpms"
printf '1\n' >"$XDG_RUNTIME_DIR/workspace"
printf '0\n' >"$XDG_RUNTIME_DIR/transform"
printf '[]\n' >"$XDG_RUNTIME_DIR/clients"
: >"$XDG_RUNTIME_DIR/commands"
: >"$XDG_RUNTIME_DIR/events"
trap 'exit' TERM INT
socat UNIX-LISTEN:"$instance/.socket.sock",fork EXEC:"$fixture/compositor-peer.sh command" & command_pid=$!
socat UNIX-LISTEN:"$instance/.socket2.sock",fork EXEC:"$fixture/compositor-peer.sh events" & event_pid=$!
trap 'kill "$command_pid" "$event_pid" 2>/dev/null || true; wait || true' EXIT
wait

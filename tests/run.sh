#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ${1:-} != --inside ]]; then
  test_name=${1:?Usage: tests/run.sh TEST BUILD_DIR}
  build=$(realpath -- "${2:?Build directory required}")
  runtime=$(mktemp -d /tmp/koya-test.XXXXXX)
  trap 'rm -rf -- "$runtime"' EXIT
  export XDG_RUNTIME_DIR=$runtime XDG_STATE_HOME=$runtime XDG_CACHE_HOME=$runtime XDG_DATA_HOME=$runtime
  unset WAYLAND_DISPLAY
  export KOYA_TEST_BUILD=$build KOYA_TEST_ROOT=$root KOYA_TEST_FAILURE=$runtime/failure
  export KOYA_TEST_APP_ROOT=$runtime/application
  export KOYA_TEST_POWER_SUPPLY_DIR=$runtime/power
  unset HYPRLAND_INSTANCE_SIGNATURE DBUS_SYSTEM_BUS_ADDRESS
  exec_path=${KOYA_BIN:-koya}
  KOYA_BIN=$(command -v -- "$exec_path") || { printf 'Koya executable not found: %s\n' "$exec_path" >&2; exit 1; }
  prefix=$(cd -- "$(dirname -- "$KOYA_BIN")/.." && pwd)
  export KOYA_BIN KOYA_PLUGIN_DIR=${KOYA_PLUGIN_DIR:-$prefix/lib} KOYA_ASSET_DIR=${KOYA_ASSET_DIR:-$prefix/share/koya/assets}
  [[ -f $KOYA_PLUGIN_DIR/libhx-dbus.so && -d $KOYA_ASSET_DIR ]] || { printf 'Set KOYA_PLUGIN_DIR and KOYA_ASSET_DIR for this Koya installation.\n' >&2; exit 1; }
  mkdir -p "$runtime/power/battery" "$runtime/power/usb" "$runtime/bin"
  mkdir -p "$KOYA_TEST_APP_ROOT"
  ln -s "$build" "$KOYA_TEST_APP_ROOT/build"
  ln -s "$root/assets" "$KOYA_TEST_APP_ROOT/assets"
  ln -s "$root/apps" "$KOYA_TEST_APP_ROOT/apps"
  printf 'Battery\n' >"$runtime/power/battery/type"
  printf '1\n' >"$runtime/power/battery/present"
  printf '73\n' >"$runtime/power/battery/capacity"
  printf 'Discharging\n' >"$runtime/power/battery/status"
  printf 'USB\n' >"$runtime/power/usb/type"
  printf '0\n' >"$runtime/power/usb/online"
  dbus-run-session --dbus-daemon="$root/tests/fixtures/dbus-daemon.sh" -- bash "$0" --inside "$test_name"
  exit
fi
export DBUS_SYSTEM_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
[[ $DBUS_SESSION_BUS_ADDRESS == *"$XDG_RUNTIME_DIR"* ]] || { printf 'Expected a private test bus.\n' >&2; exit 1; }
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
test_name=${2:?}
export KOYA_TEST_ENTRY=component
if [[ $test_name == keyboard || $test_name == hyprland ]]; then
  export HYPRLAND_INSTANCE_SIGNATURE=test KOYA_TEST_IDLE_LOCK_SECONDS=2 KOYA_TEST_IDLE_SCREEN_SECONDS=1
  setsid bash "$root/tests/fixtures/compositor.sh" & pids+=("$!")
  for attempt in {1..100}; do [[ -S $XDG_RUNTIME_DIR/hypr/test/.socket.sock ]] && break; sleep .02; done
fi
if [[ $test_name == hyprland ]]; then
  export KOYA_ICON_THEME=koya-test WAYLAND_DISPLAY=test-compositor PATH=$XDG_RUNTIME_DIR/bin:$PATH
  ln -s "$root/tests/fixtures/idle.sh" "$XDG_RUNTIME_DIR/bin/swayidle"
fi
if [[ $test_name == keyboard ]]; then
  export KOYA_TEST_KEYBOARD_FIXTURE=$root/tests/fixtures/keyboard.sh
fi
setsid timeout -k 5 65 "$KOYA_BIN" -n "$KOYA_PLUGIN_DIR" -m "$KOYA_ASSET_DIR" -m "$root" -i "tests/test-$test_name.js" </dev/null >"$XDG_RUNTIME_DIR/test.log" 2>&1 &
pids+=("$!")
wait "${pids[-1]}" || { cat "$XDG_RUNTIME_DIR/test.log" >&2; exit 1; }
cat "$XDG_RUNTIME_DIR/test.log"
[[ -f $XDG_RUNTIME_DIR/passed && ! -f $KOYA_TEST_FAILURE ]] || {
  [[ ! -f $KOYA_TEST_FAILURE ]] || cat "$KOYA_TEST_FAILURE" >&2
  for log in "$XDG_STATE_HOME/koya-shell/"*.log; do [[ ! -f $log ]] || { printf '\n%s\n' "$log" >&2; tail -30 "$log" >&2; }; done
  exit 1
}

#!/usr/bin/env bash
# No installation, hardware access or host D-Bus services. Run a live checkout.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
script=$root/dev/session.sh
fail() { printf 'local-dev: %s\n' "$*" >&2; exit 1; }
resolve_executable() {
    local found
    found=$(command -v -- "$1") || fail "Missing executable: $1"
    realpath -- "$found"
}
private_bus() {
    [[ -n ${KOYA_DEV_RUN:-} && -n ${DBUS_SESSION_BUS_ADDRESS:-} &&
       ${DBUS_SYSTEM_BUS_ADDRESS:-} == "$DBUS_SESSION_BUS_ADDRESS" ]] || fail 'This command requires the private development session.'
}
shell_call() {
    timeout 4 gdbus call --session --dest org.koya.Shell1 --object-path /org/koya/Shell1 \
        --method "org.koya.Shell1.$1" "${@:2}"
}
control() {
    private_bus
    local key edge
    case "$1" in
        restart) kill -HUP "$(cat "$KOYA_DEV_RUN/shell.pid")" ;;
        power-menu) shell_call ShowPowerMenu ;;
        power|volume-down|volume-up)
            case "$1" in power) key=116;; volume-down) key=114;; volume-up) key=115;; esac
            for edge in 1 0; do
                timeout 4 gdbus call --session --dest org.koya.Shell1 --object-path /org/koya/Shell1 \
                    --method org.koya.Shell1.Test.Button "$key" "$edge"
            done ;;
        notify)
            timeout 4 gdbus call --session --dest org.freedesktop.Notifications \
                --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications.Notify \
                'Local dev' 0 '' 'Hello from local dev' 'Edit the checkout, then press F5 to restart the shell.' '[]' '{}' 5000 ;;
        *) fail "Unknown development control: $1" ;;
    esac
}
terminate_group() {
    local pid=$1 attempt state
    kill -TERM -- "-$pid" 2>/dev/null || :
    for ((attempt=0; attempt<50; attempt++)); do
        kill -0 -- "-$pid" 2>/dev/null || break
        if [[ -r /proc/$pid/stat ]]; then
            state=$(<"/proc/$pid/stat")
            [[ "$state" != *") Z "* ]] || break
        fi
        sleep 0.1
    done
    kill -KILL -- "-$pid" 2>/dev/null || :
    wait "$pid" 2>/dev/null || :
}
supervise_shell() {
    private_bus
    local adapter_pid= restart=0 stopping=0 status=0
    trap 'restart=1; [[ -z "$adapter_pid" ]] || kill -TERM "$adapter_pid" 2>/dev/null || :' HUP
    trap 'stopping=1; [[ -z "$adapter_pid" ]] || kill -TERM "$adapter_pid" 2>/dev/null || :' TERM INT
    trap 'rm -f "$KOYA_DEV_RUN/shell.pid" "$KOYA_DEV_RUN/adapter.pid"' EXIT
    printf '%s\n' "$BASHPID" >"$KOYA_DEV_RUN/shell.pid"
    while (( ! stopping )); do
        restart=0
        setsid "$KOYA_DEV_BUILD/koya-hyprland-display-dev" "$KOYA_DEV_SOURCE" \
            "$KOYA_DEV_BUILD/koya-session-dev" "$KOYA_DEV_SOURCE" "$KOYA_DEV_RUN/component.sh" &
        adapter_pid=$!
        printf '%s\n' "$adapter_pid" >"$KOYA_DEV_RUN/adapter.pid"
        # A trapped HUP interrupts wait before the adapter finishes its cleanup.
        while kill -0 "$adapter_pid" 2>/dev/null; do
            if wait "$adapter_pid"; then status=0; else status=$?; fi
        done
        terminate_group "$adapter_pid"
        adapter_pid=
        rm -f "$KOYA_DEV_RUN/adapter.pid"
        (( restart )) || return "$status"
    done
}
session() {
    : "${DBUS_SESSION_BUS_ADDRESS:?Start through dev/session.sh}"
    [[ -v KOYA_DEV_HOST_BUS && "$DBUS_SESSION_BUS_ADDRESS" != "$KOYA_DEV_HOST_BUS" ]] || fail 'Start through dev/session.sh, which creates a private bus.'
    local run logs services_pid= compositor_pid= config state ready=0 deadline version
    umask 077
    run=$(mktemp -d /tmp/koya-dev.XXXXXX)
    logs=$KOYA_DEV_BUILD/logs/$(date +%Y%m%d-%H%M%S)-$BASHPID
    mkdir -p "$logs" "$run/source" "$run/data/applications" "$run/cache" "$run/config"
    cleanup() {
        local status=$? attempt supervisor_pid=
        trap - EXIT INT TERM
        if [[ -f "$run/shell.pid" ]]; then
            supervisor_pid=$(cat "$run/shell.pid")
            kill -TERM "$supervisor_pid" 2>/dev/null || :
        fi
        [[ -z "$compositor_pid" ]] || terminate_group "$compositor_pid"
        for ((attempt=0; attempt<50; attempt++)); do
            [[ -f "$run/shell.pid" ]] || break
            sleep 0.1
        done
        if [[ -f "$run/adapter.pid" ]]; then terminate_group "$(cat "$run/adapter.pid")"; fi
        [[ -z "$supervisor_pid" || ! -f "$run/shell.pid" ]] || kill -KILL "$supervisor_pid" 2>/dev/null || :
        [[ -z "$services_pid" ]] || terminate_group "$services_pid"
        rm -rf -- "$run"
        exit "$status"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    export KOYA_DEV_RUN=$run KOYA_DEV_SOURCE=$run/source KOYA_DEV_CHECKOUT=$root
    export DBUS_SYSTEM_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
    export XDG_RUNTIME_DIR=$run XDG_STATE_HOME=$logs XDG_CACHE_HOME=$run/cache
    export XDG_DATA_HOME=$run/data XDG_CONFIG_HOME=$run/config
    export WAYLAND_DISPLAY=$KOYA_DEV_PARENT_WAYLAND
    # With a private login service and an empty DRM selection, Aquamarine falls
    # back to its Wayland backend. Keep the parent socket absolute when changing
    # XDG_RUNTIME_DIR, so the nested compositor can still connect to the desktop.
    export LIBSEAT_BACKEND=logind AQ_DRM_DEVICES=/dev/null
    export PULSE_SERVER=unix:$run/no-audio-server GSETTINGS_BACKEND=memory GTK_THEME=Adwaita:dark
    unset HYPRLAND_INSTANCE_SIGNATURE DISPLAY DBUS_STARTER_ADDRESS DBUS_STARTER_BUS_TYPE KOYA_DBUS_DEBUG
    while IFS= read -r version; do unset "$version"; done < <(compgen -v KOYA_TEST_ || :)
    export KOYA_TEST_POWER_SUPPLY_DIR=$run/power-supply KOYA_TEST_BACKLIGHT_DIR=$run/backlight
    [[ -z "$KOYA_DEV_KEYBOARD" ]] || export KOYA_TEST_KEYBOARD_FIXTURE=$KOYA_DEV_KEYBOARD
    mkdir -p "$run/power-supply/battery" "$run/backlight/fixture"
    printf 'Battery\n' >"$run/power-supply/battery/type"
    printf '1\n' >"$run/power-supply/battery/present"
    printf '73\n' >"$run/power-supply/battery/capacity"
    printf 'Discharging\n' >"$run/power-supply/battery/status"
    printf '100\n' >"$run/backlight/fixture/max_brightness"
    printf '70\n' >"$run/backlight/fixture/brightness"
    ln -s "$root/apps" "$run/source/apps"
    ln -s "$root/assets" "$run/source/assets"
    ln -s "$KOYA_DEV_BUILD" "$run/source/build"
    cat >"$run/source/session.conf" <<'CONFIG'
[idle]
lock-seconds=0
lock-screen-seconds=0
suspend-seconds=0
[haptics]
enabled=false
CONFIG
    export KOYA_DEV_AUDIO=$root/dev/mocks/pactl.sh
    cat >"$run/source/dev-top-bar.js" <<'JS'
import build from './apps/top-bar.js';
import * as Process from 'Module/process';
export default () => build({volume: {command: Process.getEnv('KOYA_DEV_AUDIO')}});
JS
    cat >"$run/component.sh" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
entry="apps/$1.js"
[[ "$1" != top-bar ]] || entry=dev-top-bar.js
exec "$KOYA_DEV_KOYA" -n "$KOYA_DEV_PLUGINS" -m "$KOYA_DEV_ASSETS" -m "$KOYA_DEV_SOURCE" \
    -m "$KOYA_DEV_CHECKOUT" -m "$XDG_CACHE_HOME/koya/icons" -i "$entry"
WRAPPER
    cat >"$run/wifi.sh" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
exec "$KOYA_DEV_KOYA" -n "$KOYA_DEV_PLUGINS" -m "$KOYA_DEV_ASSETS" -m "$KOYA_DEV_SOURCE" \
    -m "$KOYA_DEV_CHECKOUT" -i apps/wifi.js
WRAPPER
    printf '#!/usr/bin/env bash\nexec bash %q --shell\n' "$script" >"$run/shell.sh"
    printf '#!/usr/bin/env bash\nexec bash %q --control "$1"\n' "$script" >"$run/control.sh"
    chmod +x "$run/"*.sh
    cat >"$run/data/applications/koya-wifi.desktop" <<DESKTOP
[Desktop Entry]
Name=Wi-Fi
Type=Application
Exec=$run/wifi.sh
Icon=network-wireless
DESKTOP
    config=$run/hyprland.conf
    # Translate the phone's 0.51 rules for the development compositor's 0.54 syntax.
    sed -e "s/monitor = , preferred, auto, 2/monitor = , $KOYA_DEV_SIZE@60, auto, 1/" \
        -e 's/^# Koya phone shell; syntax for Hyprland 0.51.x.$/# Koya local development; syntax for Hyprland 0.54.x./' \
        -e 's/^layerrule = noanim, /layerrule = no_anim on, match:namespace /' \
        -e 's/^windowrule = fullscreenstate 1 0, class:/windowrule = fullscreen_state 1 0, match:class /' \
        -e '/^[[:space:]]*disable_hyprland_qtutils_check = /d' \
        -e "s|@SHELL_COMMAND@|$run/shell.sh|" "$root/hyprland.conf.in" >"$config"
    local key action
    for key in F5 F6 F7 F8 F9 F10; do
        case "$key" in F5) action=restart;; F6) action=power-menu;; F7) action=power;;
            F8) action=notify;; F9) action=volume-down;; F10) action=volume-up;; esac
        printf 'bind = , %s, exec, %s/control.sh %s\n' "$key" "$run" "$action" >>"$config"
    done
    printf 'bind = , F12, exit,\n' >>"$config"
    setsid "$KOYA_DEV_BUILD/koya-dev-services" >"$logs/services.log" 2>&1 &
    services_pid=$!
    deadline=$((SECONDS + 10))
    until timeout 1 gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.NameHasOwner org.freedesktop.NetworkManager 2>/dev/null | grep -q true; do
        kill -0 "$services_pid" 2>/dev/null || fail "Development services exited; see $logs/services.log"
        (( SECONDS < deadline )) || fail "Development services did not start; see $logs"
        sleep 0.1
    done
    if ! "$KOYA_DEV_HYPRLAND" --verify-config --config "$config" >"$logs/config.log" 2>&1; then
        fail "Hyprland rejected the development configuration; see $logs/config.log"
    fi
    setsid "$KOYA_DEV_HYPRLAND" --config "$config" >"$logs/hyprland.log" 2>&1 &
    compositor_pid=$!
    printf 'Local dev: %s nested window. Logs: %s\n' "$KOYA_DEV_SIZE" "$logs"
    printf 'F5 restart | F6 power menu | F7 screen off/wake | F8 notification | F9/F10 volume | F12 exit\n'
    deadline=$((SECONDS + 30))
    while kill -0 "$compositor_pid" 2>/dev/null; do
        kill -0 "$services_pid" 2>/dev/null || fail "Development services exited; see $logs/services.log"
        if (( ready )) && [[ ! -f "$run/shell.pid" ]]; then fail "Shell supervisor exited; see $logs/koya-shell"; fi
        if (( ! ready )); then
            state=$(shell_call GetState 2>/dev/null) || state=
            if [[ "$state" == *"'Active': <true>"* && "$state" == *"'DesktopAvailable': <true>"* &&
                  "$state" == *"'wallpaperStatus': <'ready'>"* && "$state" == *"'top-barStatus': <'ready'>"* &&
                  "$state" == *"'navigationStatus': <'ready'>"* ]]; then
                ready=1
                printf 'Koya UI ready. Mouse clicks and drags work as touch input.\n'
            elif (( SECONDS >= deadline )); then fail "Shell did not become ready; see $logs"; fi
        fi
        sleep 0.2
    done
    wait "$compositor_pid" || fail "Hyprland exited unexpectedly; see $logs/hyprland.log"
    exit 0
}
case "${1:-}" in
    --shell) supervise_shell; exit $? ;;
    --control) [[ $# == 2 ]] || fail 'A control action is required'; control "$2"; exit ;;
    --session) session; exit ;;
esac
usage() {
    cat <<'HELP'
Usage: bash dev/session.sh [options]
  --koya FILE       Installed Koya executable; default koya on PATH (or KOYA_BIN)
  --assets DIR      Engine assets; detected from the installation prefix
  --plugins DIR     Matching D-Bus/process plugins; detected from installation
  --hyprland FILE   Hyprland 0.54.x executable; default Hyprland on PATH
  --keyboard FILE   Squeekboard executable; automatically detected if installed
  --size WxH        Nested output dimensions at scale 1; default 432x910
  --build-dir DIR   Native build directory; default dev/.build/host
  --no-build        Reuse native development binaries
  --help           Show this help
Run from a Linux Wayland desktop as your normal user. No sudo or installation.
For the complete release-based environment, use ./local-dev.sh.
HELP
}
koya=${KOYA_BIN:-koya} assets= plugins= hyprland=Hyprland keyboard= size=432x910 build=$root/dev/.build/host no_build=0
need_value() { [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"; }
while (( $# )); do
    case "$1" in
        --koya) need_value "$@"; koya=$2; shift;;
        --assets) need_value "$@"; assets=$2; shift;;
        --plugins) need_value "$@"; plugins=$2; shift;;
        --hyprland) need_value "$@"; hyprland=$2; shift;;
        --keyboard) need_value "$@"; keyboard=$2; shift;;
        --size) need_value "$@"; size=$2; shift;;
        --build-dir) need_value "$@"; build=$2; shift;;
        --no-build) no_build=1;;
        --help|-h) usage; exit;;
        *) fail "Unknown option: $1";;
    esac
    shift
done
[[ "$size" =~ ^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$ ]] || fail '--size must be WIDTHxHEIGHT, each from 100 to 9999.'
(( EUID != 0 )) || fail 'Run as your desktop user, without sudo.'
[[ -n ${WAYLAND_DISPLAY:-} ]] || fail 'Run from a terminal in a Linux Wayland desktop session.'
parent=$WAYLAND_DISPLAY
if [[ "$parent" != /* ]]; then parent=${XDG_RUNTIME_DIR:?Missing desktop runtime directory}/$parent; fi
[[ -S "$parent" ]] || fail "Parent Wayland socket is unavailable: $parent"
for tool in dbus-run-session gdbus setsid timeout realpath; do command -v "$tool" >/dev/null || fail "Missing $tool"; done
command -v -- "$koya" >/dev/null || fail 'Koya is not installed; use ./local-dev.sh for the release-based environment, or --koya FILE for an installed executable.'
koya=$(resolve_executable "$koya")
hyprland=$(resolve_executable "$hyprland")
version=$("$hyprland" --version)
[[ "$version" =~ 0\.54\.[0-9]+ ]] || fail 'Local development requires Hyprland 0.54.x; select it with --hyprland.'
binary_dir=$(dirname -- "$koya")
if [[ -z "$assets" ]]; then
    for candidate in "$binary_dir/../share/koya/assets" /usr/share/koya/assets; do
        if [[ -f "$candidate/fonts/SourceSans3-Regular.ttf" ]]; then assets=$candidate; break; fi
    done
fi
[[ -n "$assets" && -f "$assets/fonts/SourceSans3-Regular.ttf" ]] || fail 'Engine assets not found; set --assets DIR.'
if [[ -z "$plugins" ]]; then
    for candidate in "$binary_dir/../lib" "$binary_dir/../lib64" /usr/lib /usr/lib64; do
        if [[ -f "$candidate/libhx-dbus.so" && -f "$candidate/libhx-process.so" ]]; then plugins=$candidate; break; fi
    done
fi
[[ -n "$plugins" && -f "$plugins/libhx-dbus.so" && -f "$plugins/libhx-process.so" ]] || fail 'D-Bus/process plugins not found; set --plugins DIR.'
assets=$(realpath -- "$assets") plugins=$(realpath -- "$plugins") build=$(realpath -m -- "$build")
if [[ -n "$keyboard" ]]; then keyboard=$(resolve_executable "$keyboard"); else keyboard=$(command -v squeekboard || :); fi
[[ -n "$keyboard" ]] || printf 'Squeekboard not found: on-screen keyboard disabled; desktop keyboard still works.\n'
if (( ! no_build )); then
    bash "$root/dev/build.sh" "$build"
fi
for binary in koya-session-dev koya-hyprland-display-dev koya-dev-services koya-launch-app; do
    [[ -x "$build/$binary" ]] || fail "Missing $build/$binary; rerun without --no-build."
done
export KOYA_DEV_PARENT_WAYLAND=$parent KOYA_DEV_KOYA=$koya KOYA_DEV_HYPRLAND=$hyprland
export KOYA_DEV_ASSETS=$assets KOYA_DEV_PLUGINS=$plugins KOYA_DEV_KEYBOARD=$keyboard
export KOYA_DEV_SIZE=$size KOYA_DEV_BUILD=$build
export KOYA_DEV_HOST_BUS=${DBUS_SESSION_BUS_ADDRESS:-}
exec dbus-run-session -- bash "$script" --session

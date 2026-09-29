#!/usr/bin/env bash
# Native service contracts and launcher failure cleanup, without a GPU or phone.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
build=${1:?Pass the native development build directory}
if [[ ${2:-} != --inside ]]; then
    bash "$root/dev/session.sh" --help >/dev/null
    if bash "$root/dev/session.sh" --size broken > /dev/null 2>&1; then exit 1; fi
    exec dbus-run-session -- env KOYA_DEV_TEST_PRIVATE=1 bash "$0" "$build" --inside
fi
[[ ${KOYA_DEV_TEST_PRIVATE:-} == 1 ]] || { printf 'Start this test without --inside.\n' >&2; exit 1; }
export DBUS_SYSTEM_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
test_dir=$(mktemp -d /tmp/koya-dev-test.XXXXXX)
services_pid= parent_pid= launcher_pid=
cleanup() {
    [[ -z "$launcher_pid" ]] || kill -TERM -- "-$launcher_pid" 2>/dev/null || :
    [[ -z "$launcher_pid" ]] || wait "$launcher_pid" 2>/dev/null || :
    [[ -z "$parent_pid" ]] || kill "$parent_pid" 2>/dev/null || :
    [[ -z "$parent_pid" ]] || wait "$parent_pid" 2>/dev/null || :
    [[ -z "$services_pid" ]] || kill "$services_pid" 2>/dev/null || :
    [[ -z "$services_pid" ]] || wait "$services_pid" 2>/dev/null || :
    rm -rf "$test_dir"
}
trap cleanup EXIT
export KOYA_TEST_BACKLIGHT_DIR=$test_dir/backlight
mkdir -p "$KOYA_TEST_BACKLIGHT_DIR/fixture"
printf '70\n' >"$KOYA_TEST_BACKLIGHT_DIR/fixture/brightness"
if env -u DBUS_SYSTEM_BUS_ADDRESS "$build/koya-dev-services" >"$test_dir/guard.log" 2>&1; then exit 1; fi
"$build/koya-dev-services" >"$test_dir/services.log" 2>&1 &
services_pid=$!
call() { timeout 3 gdbus call --session --dest "$1" --object-path "$2" --method "$3" "${@:4}"; }
nm=org.freedesktop.NetworkManager
nmroot=/org/freedesktop/NetworkManager
device=$nmroot/Devices/1
deadline=$((SECONDS + 5))
until call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner "$nm" | grep -q true; do
    (( SECONDS < deadline )) || exit 1
    sleep 0.05
done
call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager.GetSessionByPID "$BASHPID" | grep -q '/session/localdev'
call org.freedesktop.login1 /org/freedesktop/login1/session/localdev org.freedesktop.DBus.Properties.Get org.freedesktop.login1.Session Active | grep -q true
call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager.PowerOff false >/dev/null
call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager.Reboot false >/dev/null
grep -q 'Mock PowerOff' "$test_dir/services.log"
grep -q 'Mock Reboot' "$test_dir/services.log"
call org.freedesktop.login1 /org/freedesktop/login1/session/localdev org.freedesktop.login1.Session.SetBrightness backlight fixture 45 >/dev/null
[[ $(cat "$KOYA_TEST_BACKLIGHT_DIR/fixture/brightness") == 45 ]]
call "$nm" /org/freedesktop org.freedesktop.DBus.ObjectManager.GetManagedObjects | grep -q 'AccessPoint/5'
call "$nm" "$device" "$nm.Device.Wireless.RequestScan" '{}' >/dev/null
call "$nm" "$device" org.freedesktop.DBus.Properties.Get "$nm.Device.Wireless" LastScan | grep -q 'int64 2'
call "$nm" "$nmroot" org.freedesktop.DBus.Properties.Set "$nm" WirelessEnabled '<false>' >/dev/null
call "$nm" "$device" org.freedesktop.DBus.Properties.Get "$nm.Device" State | grep -q 'uint32 30'
call "$nm" "$nmroot" org.freedesktop.DBus.Properties.Set "$nm" WirelessEnabled '<true>' >/dev/null
bad="{'connection': {'id': <'Test'>}, '802-11-wireless': {'ssid': <[byte 71, 114, 195, 188, 110]>}, '802-11-wireless-security': {'key-mgmt': <'wpa-psk'>, 'psk': <'wrong-password'>}}"
if call "$nm" "$nmroot" "$nm.AddAndActivateConnection" "$bad" "$device" "$nmroot/AccessPoint/2" >"$test_dir/password.log" 2>&1; then exit 1; fi
grep -q 'NoSecrets' "$test_dir/password.log"
good=${bad/wrong-password/test-password}
call "$nm" "$nmroot" "$nm.AddAndActivateConnection" "$good" "$device" "$nmroot/AccessPoint/2" | grep -q 'Settings/2'
call "$nm" "$nmroot/Settings/2" "$nm.Settings.Connection.GetSettings" | grep -q 'Test'
call "$nm" "$nmroot/Settings/2" "$nm.Settings.Connection.Update" "$good" >/dev/null
call "$nm" "$device" org.freedesktop.DBus.Properties.Get "$nm.Device.Wireless" ActiveAccessPoint | grep -q 'AccessPoint/2'
call "$nm" "$device" "$nm.Device.Disconnect" >/dev/null
call "$nm" "$nmroot/Settings/2" "$nm.Settings.Connection.Delete" >/dev/null
call "$nm" "$device" org.freedesktop.DBus.Properties.Get "$nm.Device" AvailableConnections | grep -q '\[\]'
kill "$services_pid"
wait "$services_pid"
services_pid=
# The compositor stub checks preparation, then rejects config deliberately.
# The launcher must propagate that failure and remove its private runtime.
cat >"$test_dir/Hyprland" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --verify-config && "$2" == --config ]]
[[ "$DBUS_SYSTEM_BUS_ADDRESS" == "$DBUS_SESSION_BUS_ADDRESS" ]]
[[ "$WAYLAND_DISPLAY" == "$KOYA_DEV_PARENT_WAYLAND" ]]
[[ "$WAYLAND_DISPLAY" == /* && "$XDG_RUNTIME_DIR" != "$KOYA_DEV_PARENT_WAYLAND" ]]
[[ "$LIBSEAT_BACKEND" == logind && "$AQ_DRM_DEVICES" == /dev/null ]]
[[ "$PULSE_SERVER" == "unix:$XDG_RUNTIME_DIR/no-audio-server" ]]
[[ -L "$KOYA_DEV_SOURCE/apps" && -L "$KOYA_DEV_SOURCE/build" ]]
[[ ! -v KOYA_TEST_HAPTICS && ! -v HYPRLAND_INSTANCE_SIGNATURE && ! -v DISPLAY ]]
grep -q 'monitor = , 432x910@60, auto, 1' "$3"
grep -Fxq 'layerrule = no_anim on, match:namespace ^koya-.*$' "$3"
grep -Fxq 'windowrule = fullscreen_state 1 0, match:class .*' "$3"
! grep -q 'disable_hyprland_qtutils_check' "$3"
grep -q 'F5, exec,' "$3"
grep -q 'F12, exit,' "$3"
grep -q 'suspend-seconds=0' "$KOYA_DEV_SOURCE/session.conf"
bash -n "$KOYA_DEV_RUN/component.sh" "$KOYA_DEV_RUN/wifi.sh" "$KOYA_DEV_RUN/shell.sh" "$KOYA_DEV_RUN/control.sh"
printf '%s\n' "$KOYA_DEV_RUN" >"$KOYA_DEV_AUDIT"
exit 42
STUB
chmod +x "$test_dir/Hyprland"
export KOYA_DEV_BUILD=$test_dir/build KOYA_DEV_HYPRLAND=$test_dir/Hyprland
export KOYA_DEV_KOYA=/unused/koya KOYA_DEV_ASSETS=/unused/assets KOYA_DEV_PLUGINS=/unused/plugins
export KOYA_DEV_PARENT_WAYLAND=/unused/parent-wayland KOYA_DEV_SIZE=432x910 KOYA_DEV_KEYBOARD=
export KOYA_DEV_AUDIT=$test_dir/runtime KOYA_TEST_HAPTICS=1 HYPRLAND_INSTANCE_SIGNATURE=host DISPLAY=:0
export KOYA_DEV_HOST_BUS=$DBUS_SESSION_BUS_ADDRESS
mkdir -p "$KOYA_DEV_BUILD"
ln -s "$build/koya-dev-services" "$KOYA_DEV_BUILD/koya-dev-services"
if dbus-run-session -- bash "$root/dev/session.sh" --session >"$test_dir/launcher.log" 2>&1; then exit 1; fi
grep -q 'Hyprland rejected' "$test_dir/launcher.log"
[[ -f "$test_dir/runtime" && ! -e $(cat "$test_dir/runtime") ]]
# Exercise the complete launcher, real native coordinator/adapter, restart and
# shutdown. Only the graphical compositor and Koya UI clients are simulated.
export KOYA_DEV_FIXTURE=$build/koya-local-dev-fixture KOYA_DEV_AUDIT=$test_dir/audit
layout=$test_dir/release
mkdir -p "$layout/bin" "$layout/lib" "$layout/share/koya/assets/fonts"
touch "$layout/lib/libhx-dbus.so" "$layout/lib/libhx-process.so"
touch "$layout/share/koya/assets/fonts/SourceSans3-Regular.ttf"
cat >"$layout/bin/koya" <<'STUB'
#!/usr/bin/env bash
exec "$KOYA_DEV_FIXTURE" --koya "$@"
STUB
cat >"$test_dir/nested-Hyprland" <<'STUB'
#!/usr/bin/env bash
exec "$KOYA_DEV_FIXTURE" --hyprland "$@"
STUB
chmod +x "$layout/bin/koya" "$test_dir/nested-Hyprland"
"$KOYA_DEV_FIXTURE" --parent "$test_dir/parent-wayland" &
parent_pid=$!
deadline=$((SECONDS + 5))
until [[ -S "$test_dir/parent-wayland" ]]; do (( SECONDS < deadline )) || exit 1; sleep 0.05; done
export WAYLAND_DISPLAY=$test_dir/parent-wayland
export PATH="$layout/bin:$PATH"
unset KOYA_BIN
setsid bash "$root/dev/session.sh" --hyprland "$test_dir/nested-Hyprland" \
    --build-dir "$build" --no-build >"$test_dir/nested.log" 2>&1 &
launcher_pid=$!
deadline=$((SECONDS + 15))
until grep -q 'Koya UI ready' "$test_dir/nested.log"; do
    if ! kill -0 "$launcher_pid" 2>/dev/null || (( SECONDS >= deadline )); then cat "$test_dir/nested.log"; exit 1; fi
    sleep 0.1
done
source "$test_dir/audit"
[[ "$KOYA_DEV_KOYA" == "$layout/bin/koya" && "$KOYA_DEV_ASSETS" == "$layout/share/koya/assets" && "$KOYA_DEV_PLUGINS" == "$layout/lib" ]]
old_wallpaper=$(cat "$KOYA_DEV_RUN/component-wallpaper.pid")
bash "$root/dev/session.sh" --control power >/dev/null
call org.koya.Shell1 /org/koya/Shell1 org.koya.Shell1.GetState | grep -q "'ScreenState': <'off'>"
bash "$root/dev/session.sh" --control power >/dev/null
call org.koya.Shell1 /org/koya/Shell1 org.koya.Shell1.GetState | grep -q "'ScreenState': <'locked'>"
deadline=$((SECONDS + 5))
until call org.koya.Test.lock_screen /org/koya/Test/Component org.koya.Test.Component.Action Unlock >/dev/null 2>&1; do
    (( SECONDS < deadline )) || exit 1; sleep 0.05
done
bash "$root/dev/session.sh" --control restart
deadline=$((SECONDS + 8))
until [[ $(cat "$KOYA_DEV_RUN/component-wallpaper.pid") != "$old_wallpaper" ]]; do
    (( SECONDS < deadline )) || exit 1; sleep 0.05
done
for ((attempt=0; attempt<50; attempt++)); do
    if call org.koya.Shell1 /org/koya/Shell1 org.koya.Shell1.GetState 2>/dev/null | grep -q "'navigationStatus': <'ready'>"; then break; fi
    sleep 0.05
done
call org.koya.Shell1 /org/koya/Shell1 org.koya.Shell1.GetState | grep -q "'navigationStatus': <'ready'>"
[[ ! -e /proc/$old_wallpaper ]]
new_wallpaper=$(cat "$KOYA_DEV_RUN/component-wallpaper.pid")
runtime=$KOYA_DEV_RUN
kill -TERM -- "-$launcher_pid"
wait "$launcher_pid" || :
launcher_pid=
deadline=$((SECONDS + 8))
while [[ -e "$runtime" || -e /proc/$new_wallpaper ]]; do
    (( SECONDS < deadline )) || exit 1
    sleep 0.05
done
[[ ! -e "$runtime" && ! -e /proc/$new_wallpaper ]]
printf 'PASS: private services, power/brightness/Wi-Fi mocks, installed release discovery, shell restart and cleanup\n'

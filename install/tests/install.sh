#!/bin/sh
# Offline installer checks: private files and mocked downloads/privilege only.
set -eu
shell_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_dir=$(mktemp -d /tmp/koya-install-test.XXXXXX)
trap 'rm -rf "$test_dir"' 0
export TEST_INSTALL_ROOT="$shell_root" TEST_INSTALL_DIR="$test_dir"
mkdir -p "$test_dir/fixtures/apk/keys" "$test_dir/fixtures/koya"
touch "$test_dir/fixtures/koya/koya" "$test_dir/fixtures/koya/dbus.so" \
    "$test_dir/fixtures/koya/process.so" "$test_dir/fixtures/koya/font.ttf"
sed '$d' "$shell_root/install.sh" |
    sed -e "s|/etc/koya-shell/hyprland.conf|$test_dir/fixtures/hyprland.conf|g" \
        -e "s|/etc/conf.d/tinydm|$test_dir/fixtures/tinydm|g" \
        -e "s|/proc/|$test_dir/fixtures/proc/|g" \
        -e "s|/sys/fs/cgroup|$test_dir/fixtures/cgroup|g" \
        -e "s|/etc/apk/|$test_dir/fixtures/apk/|g" \
        -e "s|/usr/bin/koya|$test_dir/fixtures/koya/koya|g" \
        -e "s|/usr/lib/libhx-dbus.so|$test_dir/fixtures/koya/dbus.so|g" \
        -e "s|/usr/lib/libhx-process.so|$test_dir/fixtures/koya/process.so|g" \
        -e "s|/usr/share/koya/assets/fonts/SourceSans3-Regular.ttf|$test_dir/fixtures/koya/font.ttf|g" \
        >"$test_dir/library.sh"
sh -n "$shell_root/install.sh"
sh "$shell_root/install.sh" --help >/dev/null
if sh "$shell_root/install.sh" --unknown >/dev/null 2>&1; then exit 1; fi
cat >"$test_dir/check.sh" <<'CHECK'
#!/bin/sh
set -eu
. "$TEST_INSTALL_DIR/library.sh"
work=$TEST_INSTALL_DIR/inputs
mkdir "$work"
source_dir=$TEST_INSTALL_ROOT
profile=oneplus-enchilada
apps=1
package_inputs
grep -qx 'hyprland~0.51' "$work/packages"
grep -qx soc-qcom-vulkan "$work/packages"
grep -qx firefox "$work/packages"
grep -qx alacritty "$work/packages"
grep -qx iio-sensor-proxy "$work/packages"
grep -qx iio-sensor-proxy-openrc "$work/packages"
grep -qx polkit-gnome "$work/packages"
grep -qx openssh-askpass "$work/packages"
grep -qx openssh-client-default "$work/packages"
grep -qx sudo "$work/packages"
grep -q "ensure_service iio-sensor-proxy" "$TEST_INSTALL_ROOT/install.sh"
grep -q "subsystem-match=misc --sysname-match='fastrpc-\*'" "$TEST_INSTALL_ROOT/install.sh"
if grep -Eq '^(python3|weston[^ ]*|wayland-dev|helix-plugins)$' "$work/packages"; then exit 1; fi
profile=generic; apps=0
package_inputs
if grep -Eq '^(soc-qcom-vulkan|device-oneplus-enchilada|firefox|alacritty)$' "$work/packages"; then exit 1; fi
valid_repo Omnomios/koya-phone
if valid_repo '../bad/repo'; then exit 1; fi
if (safe_path '/home/user/path with spaces'); then exit 1; fi
if (fetch http://example.invalid/file "$work/no-file"); then exit 1; fi

release=$TEST_INSTALL_DIR/release
prefix=$TEST_INSTALL_DIR/deployment
login_uid=10000
mkdir "$release"
cp "$TEST_INSTALL_ROOT/hyprland.conf.in" "$release/hyprland.conf.in"
cat >"$TEST_INSTALL_DIR/fixtures/hyprland.conf" <<'CONFIG'
monitor = , preferred, auto, 2
# Keep my tuning.
exec-once = exec /old/scripts/run-hyprland-shell.sh
exec-once = /duplicate/scripts/run-hyprland-shell.sh
CONFIG
cat >"$TEST_INSTALL_DIR/fixtures/tinydm" <<'LOGIN'
# Keep unrelated settings.
AUTOLOGIN_UID="1000"
rc_cgroup_cleanup="no"
SOME_SETTING=yes
LOGIN
as_login() {
    case "$1" in
        Hyprland)
            [ "$2" = --verify-config ] && [ "$3" = --config ] && [ -f "$4" ]
            printf 'config ok\n' ;;
        *) printf 'Unexpected command in offline render check: %s\n' "$1" >&2; exit 1 ;;
    esac
}
prepare_session_files
[ "$(grep -c '^exec-once' "$work/hyprland.conf")" = 2 ]
grep -Fxq "exec-once = exec $prefix/current/scripts/run-hyprland-shell.sh" "$work/hyprland.conf"
grep -Fxq 'exec-once = /usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1' "$work/hyprland.conf"
grep -Fxq 'env = SSH_ASKPASS,/usr/lib/ssh/gtk-ssh-askpass' "$work/hyprland.conf"
grep -Fxq 'env = SSH_ASKPASS_REQUIRE,force' "$work/hyprland.conf"
grep -Fxq 'env = SUDO_ASKPASS,/usr/lib/ssh/gtk-ssh-askpass' "$work/hyprland.conf"
grep -Fq '# Keep my tuning.' "$work/hyprland.conf"
cp "$work/hyprland.conf" "$TEST_INSTALL_DIR/fixtures/hyprland.conf"
prepare_session_files
[ "$(grep -c '^exec-once' "$work/hyprland.conf")" = 2 ]
[ "$(grep -c '^env = .*ASKPASS' "$work/hyprland.conf")" = 3 ]
grep -Fxq AUTOLOGIN_UID=10000 "$work/tinydm"
grep -Fxq 'rc_cgroup_cleanup="yes"' "$work/tinydm"
grep -Fxq SOME_SETTING=yes "$work/tinydm"
grep -Fxq HandlePowerKey=ignore "$work/elogind.conf"
grep -Fxq 'Exec=dbus-run-session /usr/local/bin/start-koya-hyprland' "$work/session.desktop"
sh -n "$work/launcher"

# Only the previous local graphical login is cleaned up. SSH, background
# services and other users must never enter the cgroup cleanup list.
loginctl() {
    case "$1:$2" in
        list-sessions:*) printf 'c1 10000 user seat0\nc2 10000 user seat0\nc3 10000 user -\nc4 20000 other seat0\n' ;;
        show-session:c1) printf 'Type=wayland\nSeat=seat0\nLeader=101\n' ;;
        show-session:c2) printf 'Type=tty\nSeat=seat0\nLeader=102\n' ;;
        show-session:c3) printf 'Type=unspecified\nSeat=\nLeader=103\n' ;;
        *) exit 1 ;;
    esac
}
mkdir -p "$TEST_INSTALL_DIR/fixtures/proc/101" "$TEST_INSTALL_DIR/fixtures/cgroup/c1"
printf '0::/c1\n' >"$TEST_INSTALL_DIR/fixtures/proc/101/cgroup"
printf 'populated 1\n' >"$TEST_INSTALL_DIR/fixtures/cgroup/c1/cgroup.events"
: >"$TEST_INSTALL_DIR/fixtures/cgroup/c1/cgroup.kill"
capture_graphical_sessions
[ "$(cat "$work/graphical-sessions")" = "$TEST_INSTALL_DIR/fixtures/cgroup/c1" ]
as_root() { "$@"; }
cleanup_graphical_sessions
[ "$(cat "$TEST_INSTALL_DIR/fixtures/cgroup/c1/cgroup.kill")" = 1 ]
printf '0::/\n' >"$TEST_INSTALL_DIR/fixtures/proc/101/cgroup"
if (capture_graphical_sessions); then exit 1; fi

# Run each repository installation in a fresh shell so APK errors exercise
# the installer's normal set -e behavior. All privileged writes are private.
cat >"$TEST_INSTALL_DIR/repository-case.sh" <<'REPOSITORY'
#!/bin/sh
set -eu
. "$TEST_INSTALL_DIR/library.sh"
mode=$1
work=$TEST_INSTALL_DIR/repository-$mode
mkdir "$work"
source_dir=$TEST_INSTALL_ROOT
arch=aarch64; download_base=https://example.invalid/downloads
koya_version=latest
case "$mode" in
    pinned) koya_version=9.8.7-r9999 ;;
    outdated) koya_version=0.5.3-r890 ;;
    invalid) koya_version=not-a-version ;;
esac
printf 'hyprland~0.51\ncurl\ngnupg\n' >"$work/packages"
printf 'https://example.invalid/postmarketos\n' >"$TEST_INSTALL_DIR/fixtures/apk/repositories"
rm -f "$TEST_INSTALL_DIR/fixtures/apk/keys/koya-apk.rsa.pub"
if [ "$mode" = configured ]; then
    printf 'v3 @koya %s\n' "$KOYA_REPOSITORY" >>"$TEST_INSTALL_DIR/fixtures/apk/repositories"
fi
fetch() {
    printf '%s\n' "$1" >>"$work/fetch.calls"
    case "$1" in
        */koya-packages.pub|*/koya-apk.rsa.pub|*/koya-apk.rsa.pub.sig) printf 'offline key\n' >"$2" ;;
        *) printf 'Unexpected download: %s\n' "$1" >&2; exit 1 ;;
    esac
}
gpg() {
    printf '%s\n' "$*" >>"$work/gpg.calls"
    case " $* " in
        *' show-only '*)
            key=$KOYA_KEY
            [ "$mode" != wrong-key ] || key=WRONG
            printf 'pub:::::::::\nfpr:::::::::%s:\n' "$key"
            printf 'pub:::::::::\nfpr:::::::::HISTORICAL_KEY:\n'
            ;;
        *' --export '*)
            [ "$mode" != wrong-key ]
            printf 'pinned key only\n'
            ;;
        *' --import '*)
            case "$*" in
                *"$work/gnupg"*) [ "$(cat "$work/koya-key.gpg")" = 'pinned key only' ] ;;
            esac
            ;;
        *' --verify '*) [ "$mode" != bad-signature ] ;;
        *) : ;;
    esac
}
as_root() { "$@"; }
apk() {
    printf '%s\n' "$*" >>"$work/apk.calls"
    case " $* " in
        *' --allow-untrusted '*) exit 1 ;;
        *' update '*)
            [ "$mode" != update-failure ] || [ ! -f "$TEST_INSTALL_DIR/fixtures/apk/keys/koya-apk.rsa.pub" ] ;;
        *'@koya'*)
            [ -f "$TEST_INSTALL_DIR/fixtures/apk/keys/koya-apk.rsa.pub" ]
            grep -Fxq "v3 @koya $KOYA_REPOSITORY" "$TEST_INSTALL_DIR/fixtures/apk/repositories"
            [ "$mode" != unavailable ] ;;
        ' info -v -e hyprland ') printf 'hyprland-0.51.1-r1\n' ;;
        ' info -v -e koya helix-plugin-dbus helix-plugin-process ')
            printf 'koya-9.8.7-r9999\nhelix-plugin-dbus-9.8.7-r9999\nhelix-plugin-process-9.8.7-r9999\n' ;;
        *) : ;;
    esac
}
koya() { printf 'fixture Koya\n'; }
install_packages
REPOSITORY
for mode in latest pinned configured wrong-key bad-signature outdated invalid update-failure unavailable; do
    output=$TEST_INSTALL_DIR/repository-$mode.output
    if sh "$TEST_INSTALL_DIR/repository-case.sh" "$mode" >"$output" 2>&1; then
        case "$mode" in latest|pinned|configured) ;; *) cat "$output" >&2; exit 1 ;; esac
        case_work=$TEST_INSTALL_DIR/repository-$mode
        [ "$(cat "$TEST_INSTALL_DIR/fixtures/apk/keys/koya-apk.rsa.pub")" = 'offline key' ]
        [ "$(grep -c '^v3 @koya ' "$TEST_INSTALL_DIR/fixtures/apk/repositories")" = 1 ]
        grep -Fxq 'https://example.invalid/postmarketos' "$TEST_INSTALL_DIR/fixtures/apk/repositories"
        [ "$(wc -l <"$case_work/fetch.calls")" = 3 ]
        grep -q -- "--export $KOYA_KEY" "$case_work/gpg.calls"
        grep -q -- '--verify .*koya-apk.rsa.pub.sig .*koya-apk.rsa.pub' "$case_work/gpg.calls"
        [ "$(grep -cx update "$case_work/apk.calls")" = 2 ]
        if [ "$mode" = pinned ]; then
            packages='koya@koya=9.8.7-r9999 helix-plugin-dbus@koya=9.8.7-r9999 helix-plugin-process@koya=9.8.7-r9999'
        else
            packages='koya@koya>=0.5.3-r891 helix-plugin-dbus@koya helix-plugin-process@koya'
        fi
        grep -Fxq "add --simulate --upgrade hyprland~0.51 curl gnupg $packages" "$case_work/apk.calls"
        grep -Fxq "add --upgrade hyprland~0.51 curl gnupg $packages" "$case_work/apk.calls"
        grep -Fxq 'koya-9.8.7-r9999' "$case_work/koya-installed"
    else
        case "$mode" in
            wrong-key) grep -q 'fingerprint does not match' "$output" ;;
            bad-signature) grep -q 'Bad signature: Koya Alpine repository key' "$output" ;;
            outdated) grep -q 'build 891 or newer' "$output" ;;
            invalid) grep -q 'APK version available' "$output" ;;
            update-failure|unavailable) ;;
            *) cat "$output" >&2; exit 1 ;;
        esac
        case_work=$TEST_INSTALL_DIR/repository-$mode
        if grep -q '^add --upgrade' "$case_work/apk.calls"; then exit 1; fi
        [ ! -f "$case_work/koya-installed" ]
        case "$mode" in
            update-failure|unavailable) ;;
            *)
                [ ! -f "$TEST_INSTALL_DIR/fixtures/apk/keys/koya-apk.rsa.pub" ]
                [ "$(cat "$TEST_INSTALL_DIR/fixtures/apk/repositories")" = 'https://example.invalid/postmarketos' ] ;;
        esac
    fi
done

# Phone deployment contains the application and device tooling, while dev
# environments and checks stay in the checkout. Mock compilation only here.
work=$TEST_INSTALL_DIR/deployment-work; mkdir "$work"
cp "$TEST_INSTALL_DIR/repository-latest/koya-installed" "$work/koya-installed"
login_user=fixture; ref=master; koya_version=latest; arch=aarch64
as_login() {
    if [ "$1" = meson ]; then
        case "$2" in
            setup) mkdir -p "$3" ;;
            compile)
                for binary in koya-session koya-hyprland-display koya-launch-app; do
                    printf '#!/bin/sh\nexit 0\n' >"$release/build/$binary"
                    chmod +x "$release/build/$binary"
                done ;;
            *) exit 1 ;;
        esac
    else "$@"; fi
}
prepare_deployment
[ -f "$release/apps/wallpaper.js" ]
[ -f "$release/native/session.cpp" ]
[ -f "$release/install/fix-battery-gauge.sh" ]
[ -f "$release/scripts/run-hyprland-shell.sh" ]
grep -Fxq "repository=$KOYA_REPOSITORY" "$release/install-record.txt"
grep -Fxq 'koya-9.8.7-r9999' "$release/install-record.txt"
grep -Fxq 'helix-plugin-dbus-9.8.7-r9999' "$release/install-record.txt"
grep -Fxq 'helix-plugin-process-9.8.7-r9999' "$release/install-record.txt"
[ ! -e "$release/dev" ]
[ ! -e "$release/tests" ]
[ ! -e "$release/install/tests" ]
[ ! -e "$release/native/local-dev-services.cpp" ]
CHECK
sh "$test_dir/check.sh"
printf 'PASS: offline installer manifests, config preservation, startup deduplication, graphical cgroup cleanup, signed repository installation and deployment boundaries\n'

#!/bin/sh
# Offline installer checks: private files and mocked downloads/privilege only.
set -eu
shell_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d /tmp/koya-install-test.XXXXXX)
trap 'rm -rf "$test_dir"' 0
export TEST_INSTALL_ROOT="$shell_root" TEST_INSTALL_DIR="$test_dir"
mkdir "$test_dir/fixtures"
sed '$d' "$shell_root/install.sh" |
    sed "s|/etc/koya-shell/hyprland.conf|$test_dir/fixtures/hyprland.conf|g; s|/etc/conf.d/tinydm|$test_dir/fixtures/tinydm|g" >"$test_dir/library.sh"
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
if grep -Eq '^(python3|weston[^ ]*|wayland-dev|helix-plugins)$' "$work/packages"; then exit 1; fi
profile=generic; apps=0
package_inputs
if grep -Eq '^(soc-qcom-vulkan|device-oneplus-enchilada|firefox)$' "$work/packages"; then exit 1; fi
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
[ "$(grep -c '^exec-once' "$work/hyprland.conf")" = 1 ]
grep -Fxq "exec-once = exec $prefix/current/scripts/run-hyprland-shell.sh" "$work/hyprland.conf"
grep -Fq '# Keep my tuning.' "$work/hyprland.conf"
grep -Fxq AUTOLOGIN_UID=10000 "$work/tinydm"
grep -Fxq 'rc_cgroup_cleanup="yes"' "$work/tinydm"
grep -Fxq SOME_SETTING=yes "$work/tinydm"
grep -Fxq HandlePowerKey=ignore "$work/elogind.conf"
grep -Fxq 'Exec=dbus-run-session /usr/local/bin/start-koya-hyprland' "$work/session.desktop"
sh -n "$work/launcher"

# Exercise the real download/signature flow using fake artifacts. Failed key
# fingerprints or detached signatures must abort before installation can occur.
fetch() {
    case "$1" in
        */install/index.html) printf '<a href="/downloads/koya-0.5.3-r888.aarch64.apk">apk</a>\n' >"$2" ;;
        *) printf 'offline artifact\n' >"$2" ;;
    esac
}
gpg() {
    case " $* " in
        *' show-only '*) printf 'pub:::::::::\nfpr:::::::::%s:\n' "${TEST_KEY:-$KOYA_KEY}" ;;
        *' --verify '*) [ "${TEST_BAD_SIGNATURE:-0}" = 0 ] ;;
        *) : ;;
    esac
}
arch=aarch64; download_base=https://example.invalid/downloads
if (koya_version=0.5.2-r886; get_koya); then exit 1; fi
work=$TEST_INSTALL_DIR/download-good; mkdir "$work"
koya_version=latest
get_koya
[ "$koya_version" = 0.5.3-r888 ]
[ "$(find "$work/downloads" -name '*.apk' | wc -l)" = 3 ]
[ "$(wc -l <"$work/SHA256SUMS")" = 3 ]
work=$TEST_INSTALL_DIR/download-bad-key; mkdir "$work"
if (TEST_KEY=WRONG; koya_version=0.5.3-r888; get_koya); then exit 1; fi
work=$TEST_INSTALL_DIR/download-bad-signature; mkdir "$work"
if (TEST_BAD_SIGNATURE=1; koya_version=0.5.3-r888; get_koya); then exit 1; fi
CHECK
sh "$test_dir/check.sh"
printf 'PASS: offline installer manifests, config preservation, startup deduplication and signature failure handling\n'

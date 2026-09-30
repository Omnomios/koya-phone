#!/bin/sh
# Offline worker checks. The service owns scheduling and completion state.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_dir=$(mktemp -d /tmp/koya-update-test.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
sed "s|/etc/koya-shell/update.conf|$test_dir/config|g" "$root/install/update-worker.sh" >"$test_dir/worker"
cat >"$test_dir/config" <<CONFIG
user=alice
prefix=/home/alice/.local/share/koya-shell
repo=Omnomios/koya-phone
ref=master
profile=generic
apps=0
CONFIG
cat >"$test_dir/bin/curl" <<'STUB'
#!/bin/sh
while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then cp "$TEST_UPDATE_INSTALLER" "$2"; exit; fi
    shift
done
exit 1
STUB
chmod +x "$test_dir/bin/curl"
cat >"$test_dir/installer" <<'STUB'
#!/bin/sh
[ -z "${TEST_UPDATE_INSTALLER:-}" ] || exit 99
printf 'Installer arguments: %s\n' "$*"
STUB
export TEST_UPDATE_INSTALLER=$test_dir/installer
export PATH=$test_dir/bin:$PATH
sh "$test_dir/worker" >"$test_dir/log" 2>&1
grep -q 'Installer arguments: --repo Omnomios/koya-phone --ref master --user alice --prefix /home/alice/.local/share/koya-shell --profile generic --no-apps' "$test_dir/log"
printf '#!/bin/sh\nexit 7\n' >"$test_dir/installer"
code=0
sh "$test_dir/worker" >"$test_dir/log" 2>&1 || code=$?
[ "$code" = 7 ]
printf '#!/bin/sh\nexit 22\n' >"$test_dir/bin/curl"
code=0
sh "$test_dir/worker" >"$test_dir/log" 2>&1 || code=$?
[ "$code" = 22 ]
printf 'PASS: updater worker config, clean installer environment, installer and download exit status\n'

#!/bin/sh
# Exercise the root-side handoff with a fake at queue and fake installer.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
test_dir=$(mktemp -d /tmp/koya-update-test.XXXXXX)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/state" "$test_dir/log"
sed -e "s|/var/lib/koya-shell|$test_dir/state|g" \
    -e "s|/var/log/koya-shell|$test_dir/log|g" \
    -e "s|/etc/koya-shell/update.conf|$test_dir/config|g" \
    -e "s|/usr/local/libexec/koya-update-worker|$test_dir/worker|g" \
    -e "s|/run/koya-update.lock|$test_dir/lock|g" \
    "$root/install/update-schedule.sh" >"$test_dir/schedule"
sed -e "s|/var/lib/koya-shell|$test_dir/state|g" \
    -e "s|/var/log/koya-shell|$test_dir/log|g" \
    -e "s|/etc/koya-shell/update.conf|$test_dir/config|g" \
    -e "s|/run/koya-update.lock|$test_dir/lock|g" \
    "$root/install/update-worker.sh" >"$test_dir/worker"
chmod +x "$test_dir/schedule" "$test_dir/worker"
cat >"$test_dir/config" <<CONFIG
user=alice
prefix=/home/alice/.local/share/koya-shell
repo=Omnomios/koya-phone
ref=master
profile=generic
apps=0
CONFIG
cat >"$test_dir/bin/rc-service" <<'STUB'
#!/bin/sh
[ "$1:$2" = atd:status ]
STUB
cat >"$test_dir/bin/at" <<'STUB'
#!/bin/sh
[ "$1" = -f ] && [ "$3" = now ]
cp "$2" "$TEST_UPDATE_JOB"
STUB
cat >"$test_dir/bin/curl" <<'STUB'
#!/bin/sh
while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then cp "$TEST_UPDATE_INSTALLER" "$2"; exit; fi
    shift
done
exit 1
STUB
chmod +x "$test_dir/bin/"*
cat >"$test_dir/installer" <<'STUB'
#!/bin/sh
printf 'Installer arguments: %s\n' "$*"
STUB
export TEST_UPDATE_JOB=$test_dir/job TEST_UPDATE_INSTALLER=$test_dir/installer
export PATH=$test_dir/bin:$PATH
sh "$test_dir/schedule" >/dev/null
[ "$(cat "$test_dir/state/update.status")" = queued ]
[ -f "$test_dir/job" ]
if sh "$test_dir/schedule" >"$test_dir/duplicate.log" 2>&1; then exit 1; fi
grep -q 'already in progress' "$test_dir/duplicate.log"
sh "$test_dir/job"
[ "$(cat "$test_dir/state/update.status")" = succeeded ]
grep -q 'Installer arguments: --repo Omnomios/koya-phone --ref master --user alice --prefix /home/alice/.local/share/koya-shell --profile generic --no-apps' "$test_dir/log/update.log"
cat >"$test_dir/bin/curl" <<'STUB'
#!/bin/sh
exit 7
STUB
chmod +x "$test_dir/bin/curl"
sh "$test_dir/schedule" >/dev/null
if sh "$test_dir/job"; then exit 1; fi
[ "$(cat "$test_dir/state/update.status")" = failed ]
grep -q 'Koya update failed' "$test_dir/log/update.log"
cat >"$test_dir/bin/at" <<'STUB'
#!/bin/sh
exit 4
STUB
chmod +x "$test_dir/bin/at"
if sh "$test_dir/schedule" >"$test_dir/queue-error.log" 2>&1; then exit 1; fi
[ "$(cat "$test_dir/state/update.status")" = failed ]
grep -q 'could not queue' "$test_dir/queue-error.log"
printf 'PASS: graphical update queues one system job and records worker success/failure\n'

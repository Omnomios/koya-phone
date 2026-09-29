#!/bin/sh
# Invoked through pkexec by the Update app. atd, not the graphical session,
# runs the install after this command has returned.
set -eu
[ "$(id -u)" = 0 ] || { printf 'koya-update: root required\n' >&2; exit 1; }
state_dir=/var/lib/koya-shell
status=$state_dir/update.status
log=/var/log/koya-shell/update.log
worker=/usr/local/libexec/koya-update-worker
[ -r /etc/koya-shell/update.conf ] && [ -x "$worker" ] || {
    printf 'koya-update: updater is not installed\n' >&2; exit 1;
}
rc-service atd status >/dev/null 2>&1 || {
    printf 'koya-update: atd is not running\n' >&2; exit 1;
}
install -d -m 0755 "$state_dir"
exec 9>/run/koya-update.lock
flock -w 10 9 || { printf 'koya-update: updater is busy\n' >&2; exit 1; }
case "$(cat "$status" 2>/dev/null || :)" in
    queued|running) printf 'koya-update: an update is already in progress\n' >&2; exit 1 ;;
esac
install -d -m 0755 /var/log/koya-shell
printf 'Update queued. Waiting for atd to start the installer.\n' >"$log"
chmod 0644 "$log"
printf 'queued\n' >"$status"
chmod 0644 "$status"
if ! at -f "$worker" now >/dev/null; then
    printf 'failed\n' >"$status"
    printf 'Could not queue the update with atd.\n' >"$log"
    printf 'koya-update: could not queue the update\n' >&2
    exit 1
fi
printf 'Update queued. Koya will restart after installation.\n'

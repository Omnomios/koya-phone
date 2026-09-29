#!/bin/sh
# This file is submitted to atd by update-schedule.sh. It must remain a
# standalone POSIX script: at copies it into the job when it is queued.
set -eu
state_dir=/var/lib/koya-shell
status=$state_dir/update.status
log=/var/log/koya-shell/update.log
config=/etc/koya-shell/update.conf
exec 9>/run/koya-update.lock
flock -w 30 9 || exit 1
install -d -m 0755 /var/log/koya-shell "$state_dir"
: >"$log"
chmod 0644 "$log"
exec >>"$log" 2>&1
work=
finish() {
    code=$?
    trap - EXIT HUP INT TERM
    if [ "$code" = 0 ]; then printf 'succeeded\n' >"$status"; echo 'Koya update completed.';
    else printf 'failed\n' >"$status"; echo "Koya update failed (exit $code)."; fi
    chmod 0644 "$status"
    [ -z "$work" ] || rm -rf "$work"
    exit "$code"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'running\n' >"$status"
chmod 0644 "$status"

# The config is installed by the root-run installer. Parse data as data, never
# source it as shell code. The installer validates every value again.
user= prefix= repo= ref= profile= apps=
while IFS='=' read -r key value; do
    case "$key" in
        user) user=$value ;; prefix) prefix=$value ;; repo) repo=$value ;;
        ref) ref=$value ;; profile) profile=$value ;; apps) apps=$value ;;
    esac
done <"$config"
case "$user:$prefix:$repo:$ref:$profile:$apps" in *[!a-zA-Z0-9_./:-]*|*::*) echo 'Invalid updater configuration.'; exit 1 ;; esac
[ -n "$user" ] && [ -n "$prefix" ] && [ -n "$repo" ] && [ -n "$ref" ] || {
    echo 'Incomplete updater configuration.'; exit 1;
}
case "$profile" in generic|oneplus-enchilada) ;; *) echo 'Invalid profile.'; exit 1 ;; esac
case "$apps" in 0|1) ;; *) echo 'Invalid app selection.'; exit 1 ;; esac
case "$repo" in */*) ;; *) echo 'Invalid repository.'; exit 1 ;; esac
case "$prefix" in /*) ;; *) echo 'Invalid deployment path.'; exit 1 ;; esac

work=$(mktemp -d /tmp/koya-update.XXXXXX)
echo "Fetching installer for $repo at $ref..."
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 2 --connect-timeout 20 --max-time 180 \
    --output "$work/install.sh" "https://raw.githubusercontent.com/$repo/$ref/install.sh"
[ -s "$work/install.sh" ] || { echo 'Downloaded installer is empty.'; exit 1; }
set -- --repo "$repo" --ref "$ref" --user "$user" --prefix "$prefix" --profile "$profile"
[ "$apps" = 1 ] || set -- "$@" --no-apps
echo 'Starting installation outside the graphical session...'
cd /
env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root USER=root LOGNAME=root \
    /bin/sh "$work/install.sh" "$@"

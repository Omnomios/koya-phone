#!/usr/bin/env bash
# Offline checks for repository authentication and APK package selection.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ ${1:-} == --case ]]; then
    mode=$2 work=$3
    # Redirect APK configuration to private files; no host configuration changes.
    source <(sed "s|/etc/apk/|$work/apk/|g" "$root/dev/install-koya-release.sh")
    koya_version=latest download_base=https://example.invalid/downloads
    mkdir -p "$work/apk/keys"
    printf 'https://example.invalid/alpine\n' >"$work/apk/repositories"
    case "$mode" in
        pinned) koya_version=0.5.3-r892;;
        outdated) koya_version=0.5.3-r891;;
        invalid) koya_version=not-a-version;;
        configured) printf 'v3 @koya %s\n' "$KOYA_REPOSITORY" >>"$work/apk/repositories";;
        http) fetch http://example.invalid/key "$work/key"; exit;;
    esac
    fetch() {
        printf '%s\n' "$1" >>"$work/fetch.calls"
        printf 'fixture key\n' >"$2"
    }
    gpg() {
        printf '%s\n' "$*" >>"$work/gpg.calls"
        if [[ " $* " == *' show-only '* ]]; then
            printf 'pub:::::::::\nfpr:::::::::%s:\n' \
                "$([[ "$mode" == wrong-key ]] && printf 'BADKEY' || printf '%s' "$KOYA_KEY")"
            # Only the pinned primary key may be trusted from a key bundle.
            printf 'pub:::::::::\nfpr:::::::::OTHER_KEY:\n'
        elif [[ " $* " == *' --export '* ]]; then
            printf 'pinned-key\n'
        elif [[ " $* " == *' --verify '* && "$mode" == bad-signature ]]; then
            return 1
        fi
    }
    apk() {
        printf '%s\n' "$*" >>"$work/apk.calls"
        [[ "$mode" != apk-failure ]]
    }
    install_release
    exit
fi
work_root=$(mktemp -d /tmp/koya-release-test.XXXXXX)
trap 'rm -rf "$work_root"' EXIT
for mode in latest pinned configured wrong-key bad-signature apk-failure outdated invalid http; do
    mkdir "$work_root/$mode"
    if bash "$0" --case "$mode" "$work_root/$mode" >"$work_root/$mode/output" 2>&1; then
        [[ "$mode" == latest || "$mode" == pinned || "$mode" == configured ]] || {
            printf 'Unexpected success for %s\n' "$mode" >&2; exit 1;
        }
        [[ $(cat "$work_root/$mode/apk/keys/koya-apk.rsa.pub") == 'fixture key' ]]
        [[ $(grep -c '^v3 @koya ' "$work_root/$mode/apk/repositories") == 1 ]]
        grep -Fxq 'https://example.invalid/alpine' "$work_root/$mode/apk/repositories"
        grep -Fxq 'v3 @koya https://www.koya-ui.com/repository/alpine' "$work_root/$mode/apk/repositories"
        [[ $(wc -l <"$work_root/$mode/fetch.calls") == 3 ]]
        [[ $(grep -c -- ' --verify ' "$work_root/$mode/gpg.calls") == 1 ]]
        grep -q -- '--export 06089A97B6D66C69BFD021F0DF7B60698EF57FF3' "$work_root/$mode/gpg.calls"
        grep -q -- '--verify .*koya-apk.rsa.pub.sig .*koya-apk.rsa.pub' "$work_root/$mode/gpg.calls"
        if [[ "$mode" == pinned ]]; then
            grep -Fxq 'add --no-cache koya@koya=0.5.3-r892 helix-plugin-dbus@koya=0.5.3-r892 helix-plugin-hypr@koya=0.5.3-r892 helix-plugin-process@koya=0.5.3-r892 helix-plugin-pam@koya=0.5.3-r892' "$work_root/$mode/apk.calls"
        else
            grep -Fxq 'add --no-cache koya@koya>=0.5.3-r892 helix-plugin-dbus@koya>=0.5.3-r892 helix-plugin-hypr@koya>=0.5.3-r892 helix-plugin-process@koya>=0.5.3-r892 helix-plugin-pam@koya>=0.5.3-r892' "$work_root/$mode/apk.calls"
        fi
    else
        case "$mode" in
            wrong-key) grep -q 'fingerprint does not match' "$work_root/$mode/output";;
            bad-signature) grep -q 'Bad signature: Koya Alpine repository key' "$work_root/$mode/output";;
            outdated|invalid) grep -q 'build 892 or newer' "$work_root/$mode/output";;
            http) grep -q 'URLs must use HTTPS' "$work_root/$mode/output";;
            apk-failure) [[ -s "$work_root/$mode/apk.calls" ]]; continue;;
            *) cat "$work_root/$mode/output" >&2; exit 1;;
        esac
        [[ ! -e "$work_root/$mode/apk/keys/koya-apk.rsa.pub" && ! -e "$work_root/$mode/apk.calls" ]]
    fi
done
printf 'Koya repository checks passed.\n'

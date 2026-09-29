#!/usr/bin/env bash
# Offline checks for the container's release verification gate.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ ${1:-} == --case ]]; then
    source "$root/dev/install-koya-release.sh"
    mode=$2 work=$3 arch=x86_64 koya_version=0.5.3-r888
    download_base=https://example.invalid/downloads
    case "$mode" in
        latest) koya_version=latest;;
        outdated) koya_version=0.5.3-r887;;
        http) fetch http://example.invalid/package "$work/package"; exit;;
    esac
    fetch() {
        if [[ "$1" == */install/index.html ]]; then
            printf '%s\n' 'koya-0.5.3-r888.aarch64.apk' 'koya-0.5.3-r888.x86_64.apk' >"$2"
        else
            printf 'fixture\n' >"$2"
        fi
    }
    gpg() {
        printf '%s\n' "$*" >>"$work/gpg.calls"
        if [[ " $* " == *' show-only '* ]]; then
            printf 'pub:::::::::\nfpr:::::::::%s:\n' \
                "$([[ "$mode" == wrong-key ]] && printf 'BADKEY' || printf '%s' "$KOYA_KEY")"
        elif [[ " $* " == *' --export '* ]]; then
            printf 'pinned-key\n'
        elif [[ " $* " == *' --verify '* && "$mode" == bad-signature ]]; then
            return 1
        fi
    }
    download_release
    printf '%s\n' "$koya_version" >"$work/version"
    exit
fi
work_root=$(mktemp -d /tmp/koya-release-test.XXXXXX)
trap 'rm -rf "$work_root"' EXIT
for mode in valid latest wrong-key bad-signature outdated http; do
    mkdir "$work_root/$mode"
    if bash "$0" --case "$mode" "$work_root/$mode" >"$work_root/$mode/output" 2>&1; then
        [[ "$mode" == valid || "$mode" == latest ]] || {
            printf 'Unexpected success for %s\n' "$mode" >&2; exit 1;
        }
        [[ $(cat "$work_root/$mode/version") == 0.5.3-r888 ]]
        [[ $(grep -c -- ' --verify ' "$work_root/$mode/gpg.calls") == 3 ]]
        grep -q -- "--export 06089A97B6D66C69BFD021F0DF7B60698EF57FF3" "$work_root/$mode/gpg.calls"
        for package in koya helix-plugin-dbus helix-plugin-process; do
            [[ -f "$work_root/$mode/downloads/$package-0.5.3-r888.x86_64.apk" ]]
        done
    else
        case "$mode" in
            wrong-key)
                grep -q 'fingerprint does not match' "$work_root/$mode/output"
                ! grep -q -- '--verify' "$work_root/$mode/gpg.calls";;
            bad-signature)
                grep -q 'Bad signature: koya-' "$work_root/$mode/output"
                [[ $(grep -c -- ' --verify ' "$work_root/$mode/gpg.calls") == 1 ]];;
            outdated) grep -q 'build 888 or newer' "$work_root/$mode/output";;
            http) grep -q 'URLs must use HTTPS' "$work_root/$mode/output";;
            *) cat "$work_root/$mode/output" >&2; exit 1;;
        esac
    fi
done
printf 'Release verification checks passed.\n'

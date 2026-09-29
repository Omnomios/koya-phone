#!/usr/bin/env bash
# Install the same signed Alpine release artifacts used by the phone installer.
set -euo pipefail
KOYA_KEY=06089A97B6D66C69BFD021F0DF7B60698EF57FF3
fail() { printf 'koya-release: %s\n' "$*" >&2; return 1; }
fetch() {
    [[ "$1" == https://* ]] || { fail 'Download URLs must use HTTPS'; return 1; }
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --retry 2 --connect-timeout 20 --max-time 180 --output "$2" "$1"
}
download_release() {
    local fingerprint package artifact filename
    if [[ "$koya_version" == latest ]]; then
        fetch https://developer.koya-ui.com/install/index.html "$work/install.html"
        filename=$(grep -o "koya-[0-9][0-9.]*-r[0-9][0-9]*\.$arch\.apk" "$work/install.html" | sed -n '1p')
        [[ -n "$filename" ]] || { fail 'Cannot resolve the latest Koya APK; specify a version'; return 1; }
        koya_version=${filename#koya-}; koya_version=${koya_version%.$arch.apk}
    fi
    [[ "$koya_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$ && ${koya_version##*-r} -ge 888 ]] || {
        fail 'Use a Koya APK release with build 888 or newer, such as 0.5.3-r888'; return 1;
    }
    mkdir -m 0700 "$work/key-bundle" "$work/gnupg" "$work/downloads"
    fetch "$download_base/koya-packages.pub" "$work/koya-packages.pub"
    fingerprint=$(gpg --homedir "$work/gnupg" --batch --with-colons --import-options show-only \
        --import "$work/koya-packages.pub" 2>/dev/null |
        awk -F: '$1=="pub" {primary=1} $1=="fpr" && primary {print $10; primary=0}')
    grep -Fxq "$KOYA_KEY" <<<"$fingerprint" || { fail 'Koya signing key fingerprint does not match the pinned key'; return 1; }
    # Historical keys may be in the bundle; trust only the pinned primary key.
    gpg --homedir "$work/key-bundle" --batch --import "$work/koya-packages.pub"
    gpg --homedir "$work/key-bundle" --batch --export "$KOYA_KEY" >"$work/koya-key.gpg"
    gpg --homedir "$work/gnupg" --batch --import "$work/koya-key.gpg"
    while IFS= read -r package; do
        artifact=$package-$koya_version.$arch.apk
        printf 'Downloading and verifying %s\n' "$artifact"
        fetch "$download_base/$artifact" "$work/downloads/$artifact"
        fetch "$download_base/$artifact.sig" "$work/downloads/$artifact.sig"
        gpg --homedir "$work/gnupg" --batch --verify "$work/downloads/$artifact.sig" "$work/downloads/$artifact" || {
            fail "Bad signature: $artifact"; return 1;
        }
    done < <(printf '%s\n' koya helix-plugin-dbus helix-plugin-process)
}
main() {
    koya_version=${1:-0.5.3-r888}
    if [[ "$koya_version" == --help ]]; then
        printf 'Usage: bash dev/install-koya-release.sh [VERSION|latest]\nInstalls verified Alpine APKs; default 0.5.3-r888. Intended for the container image build.\n'
        return
    fi
    [[ $# -le 1 ]] || { fail 'Supply one release version'; return 1; }
    (( EUID == 0 )) || { fail 'APK installation requires root inside the image build'; return 1; }
    arch=$(apk --print-arch)
    [[ "$arch" == x86_64 || "$arch" == aarch64 ]] || { fail "Unsupported APK architecture: $arch"; return 1; }
    [[ $(apk --version) =~ apk-tools\ ([3-9]|[1-9][0-9]+)\. ]] || { fail 'Koya APKs require apk-tools 3 or newer'; return 1; }
    download_base=${KOYA_DOWNLOAD_BASE:-https://www.koya-ui.com/downloads}
    work=$(mktemp -d /tmp/koya-release.XXXXXX)
    trap 'gpgconf --homedir "$work/gnupg" --kill gpg-agent 2>/dev/null || :; gpgconf --homedir "$work/key-bundle" --kill gpg-agent 2>/dev/null || :; rm -rf "$work"' EXIT
    download_release
    # APK's embedded trust is not used for these standalone downloads: their
    # detached signatures were verified above before the package manager runs.
    apk add --no-cache --simulate --allow-untrusted "$work"/downloads/*.apk
    apk add --no-cache --allow-untrusted "$work"/downloads/*.apk
    for path in /usr/bin/koya /usr/lib/libhx-dbus.so /usr/lib/libhx-process.so \
        /usr/share/koya/assets/fonts/SourceSans3-Regular.ttf; do
        [[ -r "$path" ]] || { fail "Release installation is missing $path"; return 1; }
    done
    mkdir -p /usr/local/share
    {
        printf 'koya=%s\narch=%s\nkey=%s\n' "$koya_version" "$arch" "$KOYA_KEY"
        (cd "$work/downloads" && sha256sum ./*.apk)
    } >/usr/local/share/koya-release.txt
    /usr/bin/koya --version
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi

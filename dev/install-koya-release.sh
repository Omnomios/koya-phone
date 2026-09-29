#!/usr/bin/env bash
# Install Koya and its plugins from the signed Alpine repository.
set -euo pipefail
KOYA_KEY=06089A97B6D66C69BFD021F0DF7B60698EF57FF3
KOYA_REPOSITORY=https://www.koya-ui.com/repository/alpine
fail() { printf 'koya-release: %s\n' "$*" >&2; return 1; }
fetch() {
    [[ "$1" == https://* ]] || { fail 'Download URLs must use HTTPS'; return 1; }
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --retry 2 --connect-timeout 20 --max-time 180 --output "$2" "$1"
}
configure_repository() {
    local fingerprint repo
    mkdir -m 0700 "$work/key-bundle" "$work/gnupg"
    fetch "$download_base/koya-packages.pub" "$work/koya-packages.pub"
    fingerprint=$(gpg --homedir "$work/gnupg" --batch --with-colons --import-options show-only \
        --import "$work/koya-packages.pub" 2>/dev/null |
        awk -F: '$1=="pub" {primary=1} $1=="fpr" && primary {print $10; primary=0}')
    grep -Fxq "$KOYA_KEY" <<<"$fingerprint" || { fail 'Koya signing key fingerprint does not match the pinned key'; return 1; }
    # Historical keys may be in the bundle; trust only the pinned primary key.
    gpg --homedir "$work/key-bundle" --batch --import "$work/koya-packages.pub"
    gpg --homedir "$work/key-bundle" --batch --export "$KOYA_KEY" >"$work/koya-key.gpg"
    gpg --homedir "$work/gnupg" --batch --import "$work/koya-key.gpg"
    fetch "$download_base/koya-apk.rsa.pub" "$work/koya-apk.rsa.pub"
    fetch "$download_base/koya-apk.rsa.pub.sig" "$work/koya-apk.rsa.pub.sig"
    gpg --homedir "$work/gnupg" --batch --verify "$work/koya-apk.rsa.pub.sig" "$work/koya-apk.rsa.pub" || {
        fail 'Bad signature: Koya Alpine repository key'; return 1;
    }
    install -m 0644 "$work/koya-apk.rsa.pub" /etc/apk/keys/koya-apk.rsa.pub
    repo="v3 @koya $KOYA_REPOSITORY"
    grep -Fxq "$repo" /etc/apk/repositories || printf '%s\n' "$repo" >>/etc/apk/repositories
}
install_release() {
    local package
    local -a packages=()
    [[ "$koya_version" == latest || ( "$koya_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$ && ${koya_version##*-r} -ge 891 ) ]] || {
        fail 'Use latest or a Koya APK release with build 891 or newer'; return 1;
    }
    configure_repository
    for package in koya helix-plugin-dbus helix-plugin-process; do
        if [[ "$koya_version" == latest ]]; then
            packages+=("$package@koya")
        else
            packages+=("$package@koya=$koya_version")
        fi
    done
    if [[ "$koya_version" == latest ]]; then packages[0]='koya@koya>=0.5.3-r891'; fi
    # APK verifies the repository index and packages using the authenticated key.
    apk add --no-cache "${packages[@]}"
}
main() {
    koya_version=${1:-latest}
    if [[ "$koya_version" == --help ]]; then
        printf 'Usage: bash dev/install-koya-release.sh [VERSION|latest]\nInstalls from the signed Koya Alpine repository; default latest. Intended for the container image build.\n'
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
    install_release
    for path in /usr/bin/koya /usr/lib/libhx-dbus.so /usr/lib/libhx-process.so \
        /usr/share/koya/assets/fonts/SourceSans3-Regular.ttf; do
        [[ -r "$path" ]] || { fail "Release installation is missing $path"; return 1; }
    done
    mkdir -p /usr/local/share
    {
        printf 'repository=%s\narch=%s\nkey=%s\n' "$KOYA_REPOSITORY" "$arch" "$KOYA_KEY"
        apk info -v -e koya helix-plugin-dbus helix-plugin-process
    } >/usr/local/share/koya-release.txt
    /usr/bin/koya --version
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi

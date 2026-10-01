#!/bin/sh
# Bootstrap a base postmarketOS install into the Koya phone shell.
# curl -fsSL https://raw.githubusercontent.com/Omnomios/koya-phone/master/install.sh | sh
set -eu

# Default publication source; --repo can override it for forks.
DEFAULT_REPO=Omnomios/koya-phone
KOYA_KEY=06089A97B6D66C69BFD021F0DF7B60698EF57FF3
KOYA_REPOSITORY=https://www.koya-ui.com/repository/alpine

say() { printf '%s\n' "$*"; }
die() { printf 'koya-install: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'HELP'
Usage: sh install.sh [options]
  --repo OWNER/REPO       GitHub source (or set KOYA_SHELL_REPO)
  --ref REF              Branch, tag or commit; default master
  --source-dir DIRECTORY Use local source instead of downloading GitHub
  --user USER            Non-root graphical login; normally detected
  --prefix DIRECTORY     Deployment; default ~/.local/share/koya-shell
  --profile PROFILE      auto (default), oneplus-enchilada, or generic
  --koya-version VERSION Package version available in the Koya Alpine repo;
                         default latest
  --no-apps              Skip Firefox, Alacritty and extra fonts
  --no-start             Install/select the session, leave tinydm stopped
  --help                Show this help
System changes use sudo internally (doas if sudo is absent), or run as root.
No installer test suspends, shuts down or changes network connections.
HELP
}
need_value() { [ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 requires a value"; }
safe_path() {
    case "$1" in /*) ;; *) die "Expected an absolute path: $1" ;; esac
    case "$1" in /|*[!a-zA-Z0-9_./-]*) die "Use a path with letters, digits, _, ., / and -: $1" ;; esac
}
valid_repo() {
    case "$1" in ''|*[!a-zA-Z0-9_./-]*|/*|*/|*../*) return 1 ;; esac
    [ "$(printf '%s\n' "$1" | awk -F/ '{print NF}')" = 2 ]
}
fetch() {
    case "$1" in https://*) ;; *) die "Download URL must use HTTPS: $1" ;; esac
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --retry 2 --connect-timeout 20 --max-time 180 --output "$2" "$1"
}
as_root() {
    if [ "$(id -u)" = 0 ]; then "$@";
    else "$privilege" "$@" </dev/tty; fi
}
as_login() {
    if [ "$(id -u)" = "$login_uid" ]; then "$@";
    else as_root setpriv --reuid "$login_uid" --regid "$login_gid" --init-groups \
        env "HOME=$login_home" "USER=$login_user" "LOGNAME=$login_user" "$@"; fi
}
cleanup() {
    cleanup_code=$?
    trap - 0 HUP INT TERM
    if [ "$cleanup_code" != 0 ]; then
        say 'Installation stopped. The installer does not retry or start a second session.' >&2
        [ "${selected:-0}" = 0 ] || say "Session files were selected; inspect $login_home/.local/state/tinydm.log before starting tinydm." >&2
        [ -z "${release:-}" ] || say "Prepared deployment: $release" >&2
    fi
    if [ -n "${work:-}" ]; then
        gpgconf --homedir "$work/gnupg" --kill gpg-agent 2>/dev/null || :
        gpgconf --homedir "$work/key-bundle" --kill gpg-agent 2>/dev/null || :
        rm -rf "$work"
    fi
    exit "$cleanup_code"
}
detect_user() {
    if [ -z "$login_user" ]; then
        if [ "$(id -u)" != 0 ]; then login_user=$(id -un);
        elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then login_user=$SUDO_USER;
        else
            detected_uid=$(sed -n "s/^[[:space:]]*AUTOLOGIN_UID=[\"']*\\([0-9][0-9]*\\).*/\\1/p" /etc/conf.d/tinydm 2>/dev/null || :)
            if [ -n "$detected_uid" ]; then
                login_user=$(getent passwd "$detected_uid" | cut -d: -f1) || :
            fi
            if [ -z "$login_user" ]; then
                candidates=$(awk -F: '$3>=1000 && $3<65534 && $6 ~ /^\/home\// && $7 !~ /(nologin|false)$/ {print $1}' /etc/passwd)
                if [ "$(printf '%s\n' "$candidates" | awk 'NF {n++} END {print n+0}')" = 1 ]; then login_user=$candidates; fi
            fi
        fi
    fi
    if [ -z "$login_user" ]; then
        [ -r /dev/tty ] || die 'Specify the graphical login with --user USER.'
        printf 'Graphical login user: ' >/dev/tty
        IFS= read -r login_user </dev/tty
    fi
    case "$login_user" in ''|*[!a-zA-Z0-9_-]*) die 'Invalid login user.' ;; esac
    record=$(getent passwd "$login_user") || die "Unknown user: $login_user"
    login_uid=$(printf '%s\n' "$record" | cut -d: -f3)
    login_gid=$(printf '%s\n' "$record" | cut -d: -f4)
    login_home=$(printf '%s\n' "$record" | cut -d: -f6)
    [ "$login_uid" != 0 ] || die 'The graphical session must not run as root.'
    [ "$(id -u)" = 0 ] || [ "$(id -u)" = "$login_uid" ] || die 'Run as the graphical user or root.'
    safe_path "$login_home"
    [ -d "$login_home" ] || die "Missing login home: $login_home"
    prefix=${prefix:-$login_home/.local/share/koya-shell}
    safe_path "$prefix"
    case "$prefix" in *'/../'*|*'/..'|*'/./'*|*'/.'|*'//'*) die 'Use a normalized deployment path.' ;; esac
    case "$prefix" in "$login_home"/*) ;; *) die '--prefix must be inside the graphical user home.' ;; esac
}
platform() {
    [ -r /etc/os-release ] || die 'Missing /etc/os-release.'
    grep -Eq "^ID=[\"']?postmarketos[\"']?$" /etc/os-release || die 'This installer targets postmarketOS.'
    for tool in apk curl tar awk sed getent; do command -v "$tool" >/dev/null || die "Missing bootstrap tool: $tool"; done
    arch=$(apk --print-arch)
    case "$arch" in aarch64|x86_64) ;; *) die "Unsupported architecture: $arch" ;; esac
    apk_major=$(apk --version | sed -n 's/^apk-tools \([0-9][0-9]*\)\..*/\1/p')
    case "$apk_major" in ''|*[!0-9]*) die 'Cannot determine apk-tools version.' ;; esac
    [ "$apk_major" -ge 3 ] || die 'The Koya repository requires apk-tools 3 or newer (postmarketOS v25.12 or newer).'
    case "$profile" in
        auto)
            if apk info -e device-oneplus-enchilada >/dev/null 2>&1; then profile=oneplus-enchilada;
            else profile=generic; fi ;;
        oneplus-enchilada)
            apk info -e device-oneplus-enchilada >/dev/null 2>&1 || die 'The OnePlus profile requires a OnePlus 6 base image.' ;;
        generic) ;;
        *) die "Unknown device profile: $profile" ;;
    esac
    if [ "$(id -u)" != 0 ]; then
        [ -r /dev/tty ] || die 'Run in a terminal so sudo can request authentication.'
        if command -v sudo >/dev/null; then privilege=sudo;
        elif command -v doas >/dev/null; then privilege=doas;
        else die 'Install/configure sudo or doas, or run this script from a root shell.'; fi
    fi
}
get_source() {
    source_commit=
    if [ -n "$source_dir" ]; then
        source_dir=$(CDPATH= cd -- "$source_dir" && pwd -P)
    else
        valid_repo "$repo" || die 'Supply --repo OWNER/REPO (or set DEFAULT_REPO before publishing).'
        case "$ref" in ''|*[!a-zA-Z0-9_./-]*|/*|*..*) die 'Invalid GitHub ref.' ;; esac
        # Pin the archive to the revision we record, so a moving branch cannot
        # advance between resolving it and downloading the deployment.
        encoded_ref=$(printf '%s' "$ref" | sed 's|/|%2F|g')
        if curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
            --connect-timeout 8 --max-time 20 -H 'Accept: application/vnd.github+json' \
            --output "$work/source-commit.json" "https://api.github.com/repos/$repo/commits/$encoded_ref" 2>/dev/null; then
            source_commit=$(sed -n 's/^[[:space:]]*"sha": "\([0-9a-f]\{40\}\)",/\1/p' "$work/source-commit.json" | sed -n '1p')
        fi
        archive_ref=${source_commit:-$ref}
        # Moving refs can leave a cached archive behind a freshly fetched
        # bootstrap script. A unique URL makes each install resolve the ref.
        source_url=https://codeload.github.com/$repo/tar.gz/$archive_ref?koya_cache_bust=$(date +%s)-$$
        say "Downloading $repo ($ref)..."
        fetch "$source_url" "$work/source.tar.gz"
        tar -tzf "$work/source.tar.gz" >"$work/archive-files"
        if grep -Eq '(^/|(^|/)\.\.(/|$))' "$work/archive-files"; then die 'Unsafe source archive paths.'; fi
        mkdir "$work/source"
        tar -xzf "$work/source.tar.gz" --strip-components=1 -C "$work/source"
        source_dir=$work/source
    fi
    for required in meson.build meson_options.txt hyprland.conf.in session.conf run.sh \
        start-hyprland.sh scripts/run-hyprland-shell.sh scripts/run-wifi.sh scripts/run-settings.sh scripts/run-update.sh \
        install/koya-update.initd install/org.koya.Update1.conf install/org.koya.update.policy install/update-worker.sh applications/koya-update.desktop \
        install/packages/runtime.list install/packages/build.list install/packages/koya.list; do
        [ -f "$source_dir/$required" ] || die "Source is missing $required"
    done
}
manifest() {
    awk '{sub(/#.*/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); if (length($0)) print}' "$1"
}
package_inputs() {
    manifest "$source_dir/install/packages/runtime.list" >"$work/packages"
    manifest "$source_dir/install/packages/build.list" >>"$work/packages"
    [ "$profile" = generic ] || manifest "$source_dir/install/packages/$profile.list" >>"$work/packages"
    [ "$apps" = 0 ] || manifest "$source_dir/install/packages/apps.list" >>"$work/packages"
    printf 'curl\ngnupg\n' >>"$work/packages"
    # The committed template is tested with 0.51.x. Do not change repo branches
    # or install a newer compositor whose configuration syntax differs.
    awk '$0=="hyprland" {$0="hyprland~0.51"} !seen[$0]++' "$work/packages" >"$work/packages.unique"
    mv "$work/packages.unique" "$work/packages"
    if grep -Eq '[^a-zA-Z0-9_+.,~=-]|^-' "$work/packages"; then die 'Invalid APK package manifest.'; fi
}
verify_koya_key() {
    mkdir -m 0700 "$work/gnupg"
    mkdir -m 0700 "$work/key-bundle"
    fetch "$download_base/koya-packages.pub" "$work/koya-packages.pub"
    fingerprints=$(gpg --homedir "$work/gnupg" --batch --with-colons --import-options show-only \
        --import "$work/koya-packages.pub" 2>/dev/null |
        awk -F: '$1=="pub" {primary=1} $1=="fpr" && primary {print $10; primary=0}')
    printf '%s\n' "$fingerprints" | grep -Fxq "$KOYA_KEY" || die 'Koya signing key fingerprint does not match the pinned key.'
    # The published bundle includes historical keys. Only the pinned primary key
    # and its subkeys may enter the keyring used to verify the repository key.
    gpg --homedir "$work/key-bundle" --batch --import "$work/koya-packages.pub"
    gpg --homedir "$work/key-bundle" --batch --export "$KOYA_KEY" >"$work/koya-key.gpg"
    gpg --homedir "$work/gnupg" --batch --import "$work/koya-key.gpg"
}
configure_koya_repository() {
    case "$download_base" in https://*) ;; *) die 'KOYA_DOWNLOAD_BASE must use HTTPS.' ;; esac
    if [ "$koya_version" != latest ]; then
        printf '%s\n' "$koya_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$' || die 'Use latest or an APK version available in the Koya repository.'
        [ "${koya_version##*-r}" -ge 892 ] || die 'This shell requires Koya build 892 or newer.'
    fi
    manifest "$source_dir/install/packages/koya.list" >"$work/koya-package-names"
    [ "$(cat "$work/koya-package-names")" = "$(printf 'koya\nhelix-plugin-dbus\nhelix-plugin-hypr\nhelix-plugin-process\nhelix-plugin-pam')" ] || die 'Unexpected Koya package set.'
    : >"$work/koya-packages"
    while IFS= read -r package; do
        if [ "$koya_version" != latest ]; then
            printf '%s@koya=%s\n' "$package" "$koya_version"
        else
            printf '%s@koya>=0.5.3-r892\n' "$package"
        fi
    done <"$work/koya-package-names" >"$work/koya-packages"
    verify_koya_key
    fetch "$download_base/koya-apk.rsa.pub" "$work/koya-apk.rsa.pub"
    fetch "$download_base/koya-apk.rsa.pub.sig" "$work/koya-apk.rsa.pub.sig"
    gpg --homedir "$work/gnupg" --batch --verify "$work/koya-apk.rsa.pub.sig" "$work/koya-apk.rsa.pub" || die 'Bad signature: Koya Alpine repository key.'
    as_root install -m 0644 "$work/koya-apk.rsa.pub" /etc/apk/keys/koya-apk.rsa.pub
    # A tagged repository limits package selection to the requested Koya packages.
    as_root sh -c 'repo="v3 @koya $1"; grep -Fxq "$repo" /etc/apk/repositories || printf "%s\n" "$repo" >>/etc/apk/repositories' sh "$KOYA_REPOSITORY"
}
install_packages() {
    say 'Refreshing existing repositories and checking package availability...'
    as_root apk update
    set --
    while IFS= read -r package; do set -- "$@" "$package"; done <"$work/packages"
    as_root apk add --simulate "$@"
    # Authenticate the repository key before enabling it for APK installation.
    as_root apk add curl gnupg
    configure_koya_repository
    as_root apk update
    while IFS= read -r package; do set -- "$@" "$package"; done <"$work/koya-packages"
    # APK verifies the repository index and packages using the authenticated key.
    as_root apk add --simulate --upgrade "$@"
    as_root apk add --upgrade "$@"
    apk info -v -e koya helix-plugin-dbus helix-plugin-hypr helix-plugin-process helix-plugin-pam >"$work/koya-installed"
    apk info -v -e hyprland | grep -q '^hyprland-0\.51\.' || die 'Installed Hyprland is not 0.51.x.'
    for needed in /usr/bin/koya /usr/lib/libhx-dbus.so /usr/lib/libhx-hypr.so /usr/lib/libhx-process.so /usr/lib/libhx-pam.so \
        /usr/share/koya/assets/fonts/SourceSans3-Regular.ttf; do
        [ -r "$needed" ] || die "Koya installation is missing $needed"
    done
    koya --version
}
prepare_deployment() {
    say "Building the Hyprland shell as $login_user..."
    as_login mkdir -p "$prefix/releases"
    as_login chmod 0755 "$prefix" "$prefix/releases"
    [ ! -e "$prefix/current" ] || [ -L "$prefix/current" ] || die "Refusing to replace non-symlink $prefix/current"
    release=$prefix/releases/$(date +%Y%m%d-%H%M%S)-$$
    as_login mkdir "$release"
    tar -cf "$work/deployment.tar" -C "$source_dir" apps assets native applications install/packages \
        scripts/run-hyprland-shell.sh scripts/run-wifi.sh scripts/run-settings.sh scripts/run-update.sh \
        install/fix-battery-gauge.sh install/koya-update.initd install/org.koya.Update1.conf install/org.koya.update.policy install/org.koya.credential.policy install/koya-lock.pam install/koya-credential.pam install/update-worker.sh start-hyprland.sh run.sh \
        meson.build meson_options.txt hyprland.conf.in session.conf README.md
    chmod 0644 "$work/deployment.tar"
    as_login tar -xf "$work/deployment.tar" -C "$release"
    # Preserve user policy on reruns, while new settings retain native defaults.
    if [ -f "$prefix/current/session.conf" ]; then
        as_login cp "$prefix/current/session.conf" "$release/session.conf"
    fi
    as_login meson setup "$release/build" "$release" -Dintegration_tests=false --buildtype=release
    as_login meson compile -C "$release/build"
    for binary in koya-session koya-hyprland-display koya-launch-app koya-askpass koya-update-service koya-credential-update; do
        [ -x "$release/build/$binary" ] || die "Missing built binary: $binary"
    done
    for module in desktop linux-device polkit-agent credentials; do
        [ -r "$release/build/native/modules/libhx-$module.so" ] || die "Missing built module: $module"
    done
    as_login chmod +x "$release/start-hyprland.sh" "$release/run.sh" \
        "$release/scripts/run-hyprland-shell.sh" "$release/scripts/run-wifi.sh" "$release/scripts/run-settings.sh" "$release/scripts/run-update.sh"
    awk -v path="$prefix/current/scripts/run-wifi.sh" '/^Exec=/ {$0="Exec=" path} {print}' \
        "$release/applications/koya-wifi.desktop" >"$work/wifi.desktop"
    as_login cp "$work/wifi.desktop" "$release/applications/koya-wifi.desktop"
    awk -v path="$prefix/current/scripts/run-settings.sh" '/^Exec=/ {$0="Exec=" path} {print}' \
        "$release/applications/koya-settings.desktop" >"$work/settings.desktop"
    as_login cp "$work/settings.desktop" "$release/applications/koya-settings.desktop"
    awk -v path="$prefix/current/scripts/run-update.sh" '/^Exec=/ {$0="Exec=" path} {print}' \
        "$release/applications/koya-update.desktop" >"$work/update.desktop"
    as_login cp "$work/update.desktop" "$release/applications/koya-update.desktop"
    {
        printf 'source=%s\nref=%s\nkoya=%s\nrepository=%s\narch=%s\nprofile=%s\nkey=%s\n' \
            "${source_url:-local:$source_dir}" "$ref" "$koya_version" "$KOYA_REPOSITORY" "$arch" "$profile" "$KOYA_KEY"
        [ -z "${source_commit:-}" ] || printf 'source_commit=%s\n' "$source_commit"
        [ ! -f "$work/source.tar.gz" ] || sha256sum "$work/source.tar.gz" | awk '{print "source_sha256=" $1}'
        cat "$work/koya-installed"
    } >"$work/install-record.txt"
    as_login cp "$work/install-record.txt" "$release/install-record.txt"
}
prepare_session_files() {
    askpass=$prefix/current/build/koya-askpass
    awk -v command="$prefix/current/scripts/run-hyprland-shell.sh" -v askpass="$askpass" \
        '{sub(/@SHELL_COMMAND@/, command); sub(/@ASKPASS_COMMAND@/, askpass); print}' \
        "$release/hyprland.conf.in" >"$work/hyprland.conf"
    # Preserve compositor tuning on reruns. Remove the old polkit agent and
    # replace default GTK askpass paths; keep user-supplied helpers.
    if [ -f /etc/koya-shell/hyprland.conf ]; then
        awk -v command="$prefix/current/scripts/run-hyprland-shell.sh" -v askpass="$askpass" \
            '/^[[:space:]]*exec-once[[:space:]]*=.*run-hyprland-shell\.sh/ {if (!shell) print "exec-once = exec " command; shell=1; next} \
             /^[[:space:]]*exec-once[[:space:]]*=.*(polkit|policykit)/ {next} \
             /^[[:space:]]*env[[:space:]]*=[[:space:]]*SSH_ASKPASS,/ {
                 ssh=1; if ($0 ~ /\/usr\/lib\/ssh\/gtk-ssh-askpass/) print "env = SSH_ASKPASS," askpass; else print; next
             } \
             /^[[:space:]]*env[[:space:]]*=[[:space:]]*SSH_ASKPASS_REQUIRE,/ {ssh_require=1} \
             /^[[:space:]]*env[[:space:]]*=[[:space:]]*SUDO_ASKPASS,/ {
                 sudo=1; if ($0 ~ /\/usr\/lib\/ssh\/gtk-ssh-askpass/) print "env = SUDO_ASKPASS," askpass; else print; next
             } \
             {print} \
             END {if (!shell) print "exec-once = exec " command; \
                  if (!ssh) print "env = SSH_ASKPASS," askpass; \
                  if (!ssh_require) print "env = SSH_ASKPASS_REQUIRE,force"; \
                  if (!sudo) print "env = SUDO_ASKPASS," askpass}' \
            /etc/koya-shell/hyprland.conf >"$work/hyprland.conf"
    fi
    chmod 0644 "$work/hyprland.conf"
    # Verify syntax only: no compositor, DRM session or graphical test is started.
    # Scheduled self-updates run outside the login session and have no
    # XDG_RUNTIME_DIR. Hyprland requires one even for --verify-config.
    verify_runtime=$release/.verify-runtime
    as_login mkdir -m 0700 "$verify_runtime"
    as_login env "XDG_RUNTIME_DIR=$verify_runtime" Hyprland --verify-config --config "$work/hyprland.conf" >"$work/verify-config.log" 2>&1 || {
        as_login rm -rf "$verify_runtime"
        cat "$work/verify-config.log" >&2; die 'Hyprland rejected the prepared configuration.';
    }
    as_login rm -rf "$verify_runtime"
    grep -q 'config ok' "$work/verify-config.log" || { cat "$work/verify-config.log" >&2; die 'Hyprland config verification did not report success.'; }
    printf '#!/bin/sh\nexec "%s/current/start-hyprland.sh" "$@"\n' "$prefix" >"$work/launcher"
    cat >"$work/session.desktop" <<'DESKTOP'
[Desktop Entry]
Name=Koya
Comment=Koya phone shell on Hyprland
Exec=dbus-run-session /usr/local/bin/start-koya-hyprland
Type=Application
DesktopNames=Hyprland;
DESKTOP
    cat >"$work/elogind.conf" <<'ELOGIND'
[Login]
HandlePowerKey=ignore
HandlePowerKeyLongPress=ignore
ELOGIND
    if [ -r /etc/conf.d/tinydm ]; then cat /etc/conf.d/tinydm >"$work/tinydm.original";
    else : >"$work/tinydm.original"; fi
    awk '!/^[[:space:]]*(AUTOLOGIN_UID|rc_cgroup_cleanup)[[:space:]]*=/' "$work/tinydm.original" >"$work/tinydm"
    printf '\nrc_cgroup_cleanup="yes"\nAUTOLOGIN_UID=%s\n' "$login_uid" >>"$work/tinydm"
    valid_repo "$repo" || die 'Self-update requires a repository in OWNER/REPO form.'
    case "$ref" in ''|*[!a-zA-Z0-9_./-]*|/*|*..*) die 'Invalid update ref.' ;; esac
    printf 'user=%s\nprefix=%s\nrepo=%s\nref=%s\nprofile=%s\napps=%s\n' \
        "$login_user" "$prefix" "$repo" "$ref" "$profile" "$apps" >"$work/update.conf"
}
ensure_service() {
    [ -x "/etc/init.d/$1" ] || die "Missing OpenRC service: $1"
    as_root rc-update add "$1" "${2:-default}"
    if ! as_root rc-service "$1" status >/dev/null 2>&1; then as_root rc-service "$1" start; fi
}
configure_system() {
    for group in input video render audio netdev plugdev; do
        if getent group "$group" >/dev/null && ! id -Gn "$login_user" | tr ' ' '\n' | grep -qx "$group"; then
            as_root addgroup "$login_user" "$group"
        fi
    done
    ensure_service cgroups boot
    ensure_service dbus
    ensure_service elogind
    ensure_service polkit
    # Leave running networking and hardware services alone. Starting an absent
    # NM service supplies the Wi-Fi UI; no connection is activated by this script.
    ensure_service networkmanager
    # The base image owns modem/audio integration and udev. Do not start a
    # second PulseAudio instance, independent keyboard, feedbackd or swayidle.
    as_root install -d -m 0755 /etc/koya-shell /etc/elogind/logind.conf.d \
        /usr/local/bin /usr/local/libexec /usr/share/wayland-sessions /var/lib/tinydm
    as_root install -m 0644 "$work/update.conf" /etc/koya-shell/update.conf
    as_root install -d -m 0755 /etc/dbus-1/system.d /usr/share/polkit-1/actions
    # Replace the executable atomically; the active service finishes its own
    # update using its already mapped binary and is not restarted here.
    as_root install -d -m 0755 /etc/pam.d
    as_root install -m 0644 "$release/install/koya-lock.pam" /etc/pam.d/koya-lock
    as_root install -m 0644 "$release/install/koya-credential.pam" /etc/pam.d/koya-credential
    as_root install -m 0644 "$release/install/org.koya.credential.policy" /usr/share/polkit-1/actions/org.koya.credential.policy
    as_root install -m 0755 "$release/build/koya-credential-update" /usr/local/libexec/koya-credential-update.new
    as_root mv /usr/local/libexec/koya-credential-update.new /usr/local/libexec/koya-credential-update
    as_root install -m 0755 "$release/build/koya-update-service" /usr/local/libexec/koya-update-service.new
    as_root mv /usr/local/libexec/koya-update-service.new /usr/local/libexec/koya-update-service
    as_root install -m 0755 "$release/install/koya-update.initd" /etc/init.d/koya-update
    as_root install -m 0644 "$release/install/org.koya.Update1.conf" /etc/dbus-1/system.d/org.koya.Update1.conf
    as_root install -m 0644 "$release/install/org.koya.update.policy" /usr/share/polkit-1/actions/org.koya.update.policy
    as_root dbus-send --system --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ReloadConfig >/dev/null
    as_root install -m 0755 "$release/install/update-worker.sh" /usr/local/libexec/koya-update-worker.new
    as_root mv /usr/local/libexec/koya-update-worker.new /usr/local/libexec/koya-update-worker
    as_root rm -f /usr/local/libexec/koya-update-schedule
    ensure_service koya-update
    as_root install -m 0644 "$work/elogind.conf" /etc/elogind/logind.conf.d/90-koya-shell.conf
    as_root rc-service elogind reload
    as_root udevadm control --reload-rules
    as_root udevadm trigger --action=change --subsystem-match=input
    as_root udevadm trigger --action=change --subsystem-match=iio
    # The Qualcomm sensor proxy rules may have been installed after FastRPC
    # devices appeared. Refresh just those nodes before starting the proxy.
    as_root udevadm trigger --action=change --subsystem-match=misc --sysname-match='fastrpc-*'
    as_root udevadm settle
    ensure_service iio-sensor-proxy
    # Persist vibration without sound for the graphical user, including root installs.
    as_login dbus-run-session -- env GSETTINGS_BACKEND=dconf \
        gsettings set org.sigxcpu.feedbackd profile quiet
}
capture_graphical_sessions() {
    : >"$work/graphical-sessions"
    loginctl list-sessions --no-legend >"$work/login-sessions"
    while read -r session_id session_uid rest; do
        [ "$session_uid" = "$login_uid" ] || continue
        case "$session_id" in ''|*[!a-zA-Z0-9]*) continue ;; esac
        session_info=$(loginctl show-session "$session_id" -p Type -p Seat -p Leader)
        session_type=$(printf '%s\n' "$session_info" | sed -n 's/^Type=//p')
        session_seat=$(printf '%s\n' "$session_info" | sed -n 's/^Seat=//p')
        session_leader=$(printf '%s\n' "$session_info" | sed -n 's/^Leader=//p')
        case "$session_type:$session_seat" in wayland:?*|x11:?*) ;; *) continue ;; esac
        case "$session_leader" in ''|*[!0-9]*) die 'Invalid graphical session leader.' ;; esac
        session_cgroup=$(awk -F: '$1=="0" && $2=="" {print $3}' "/proc/$session_leader/cgroup")
        # elogind on this platform moves the login out of OpenRC's service
        # cgroup. Stopping tinydm can then unregister it while leaving children.
        # Remember only the matching elogind cgroup, never a user/root cgroup.
        if [ "$session_cgroup" = "/$session_id" ]; then
            [ -e "/sys/fs/cgroup$session_cgroup/cgroup.kill" ] || die 'Graphical session cleanup requires kernel cgroup.kill support.'
            printf '%s\n' "/sys/fs/cgroup$session_cgroup" >>"$work/graphical-sessions"
        else
            die "Unsupported graphical session cgroup: $session_cgroup"
        fi
    done <"$work/login-sessions"
}
cleanup_graphical_sessions() {
    while IFS= read -r session_cgroup; do
        [ -d "$session_cgroup" ] || continue
        grep -q '^populated 1$' "$session_cgroup/cgroup.events" || continue
        [ -e "$session_cgroup/cgroup.kill" ] || die "Cannot clean up old graphical session: $session_cgroup"
        say "Cleaning up the previous graphical session: $session_cgroup"
        as_root sh -c 'printf 1 > "$1/cgroup.kill"' sh "$session_cgroup"
    done <"$work/graphical-sessions"
}
select_session() {
    say 'Selecting the Koya session...'
    # Only stop display managers at the end, after all downloads/build/config
    # verification succeed. Never kill processes by name or spawn a retry loop.
    capture_graphical_sessions
    for manager in tinydm lightdm gdm sddm greetd xdm; do
        if [ -x "/etc/init.d/$manager" ]; then
            if as_root rc-service "$manager" status >/dev/null 2>&1; then as_root rc-service "$manager" stop; fi
            if [ "$manager" != tinydm ]; then
                for level in default boot; do
                    if [ -e "/etc/runlevels/$level/$manager" ]; then as_root rc-update del "$manager" "$level"; fi
                done
            fi
        fi
    done
    cleanup_graphical_sessions
    runtime=/tmp/$login_uid-runtime-dir
    for held_lock in koya-compositor.lock koya-shell.lock koya-hyprland-bridge.lock; do
        if [ -e "$runtime/$held_lock" ]; then
            as_root flock -w 8 "$runtime/$held_lock" true || die "The old session still holds $held_lock; leaving tinydm stopped."
        fi
    done
    as_login ln -s "$release" "$prefix/current.new.$$"
    as_login mv -fT "$prefix/current.new.$$" "$prefix/current"
    as_root install -m 0644 "$work/hyprland.conf" /etc/koya-shell/hyprland.conf
    as_root install -m 0755 "$work/launcher" /usr/local/bin/start-koya-hyprland
    as_root install -m 0644 "$work/session.desktop" /usr/share/wayland-sessions/koya-hyprland.desktop
    as_root install -m 0644 "$work/tinydm" /etc/conf.d/tinydm
    as_root ln -s /usr/share/wayland-sessions/koya-hyprland.desktop /var/lib/tinydm/default-session.new.$$
    as_root mv -fT /var/lib/tinydm/default-session.new.$$ /var/lib/tinydm/default-session.desktop
    as_root rc-update add tinydm default
    selected=1
    [ "$start" = 0 ] || as_root rc-service tinydm start
}
wait_session() {
    say 'Waiting for the normal graphical session (read-only startup check)...'
    readiness_deadline=$(( $(date +%s) + 40 ))
    while [ "$(date +%s)" -lt "$readiness_deadline" ]; do
        adapter_pid=; coordinator_pid=; session_bus=
        if [ -r "$runtime/koya-hyprland.state" ]; then
            while IFS='=' read -r state_key state_value; do
                case "$state_key" in
                    bridge_pid) adapter_pid=$state_value ;;
                    coordinator_pid) coordinator_pid=$state_value ;;
                    dbus_address) session_bus=$state_value ;;
                esac
            done <"$runtime/koya-hyprland.state"
            case "$adapter_pid:$coordinator_pid" in *[!0-9:]*|:*|*:) sleep 1; continue ;; esac
            if [ "$(readlink "/proc/$adapter_pid/exe" 2>/dev/null || :)" = "$release/build/koya-hyprland-display" ] &&
               [ "$(readlink "/proc/$coordinator_pid/exe" 2>/dev/null || :)" = "$release/build/koya-session" ] &&
               [ -n "$session_bus" ]; then
                if snapshot=$(as_login timeout 3 env "DBUS_SESSION_BUS_ADDRESS=$session_bus" "XDG_RUNTIME_DIR=$runtime" \
                    gdbus call --session --dest org.koya.Shell1 --object-path /org/koya/Shell1 \
                    --method org.koya.Shell1.GetState 2>/dev/null); then
                    ready=1
                    for field in "'Active': <true>" "'wallpaperStatus': <'ready'>" "'top-barStatus': <'ready'>" \
                        "'navigationStatus': <'ready'>" "'KeyboardAvailable': <true>" "'DesktopAvailable': <true>" "'LastError': <''>"; do
                        printf '%s\n' "$snapshot" | grep -Fq "$field" || ready=0
                    done
                    if [ "$ready" = 1 ]; then
                        say "Koya ready: adapter=$adapter_pid coordinator=$coordinator_pid"
                        return
                    fi
                fi
            fi
        fi
        sleep 1
    done
    for log in tinydm.log koya-shell/session.log koya-shell/top-bar.log koya-shell/hyprland-display.log; do
        if [ -r "$login_home/.local/state/$log" ]; then
            say "--- $log ---" >&2
            tail -n 15 "$login_home/.local/state/$log" >&2
        fi
    done
    die 'The graphical session did not become ready; see the session logs above.'
}
main() {
    repo=${KOYA_SHELL_REPO:-$DEFAULT_REPO}; ref=master; source_dir=; source_url=
    login_user=; prefix=; profile=auto; koya_version=latest; apps=1; start=1
    download_base=${KOYA_DOWNLOAD_BASE:-https://www.koya-ui.com/downloads}
    privilege=; work=; release=; selected=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --repo) need_value "$@"; repo=$2; shift ;;
            --ref) need_value "$@"; ref=$2; shift ;;
            --source-dir) need_value "$@"; source_dir=$2; shift ;;
            --user) need_value "$@"; login_user=$2; shift ;;
            --prefix) need_value "$@"; prefix=$2; shift ;;
            --profile) need_value "$@"; profile=$2; shift ;;
            --koya-version) need_value "$@"; koya_version=$2; shift ;;
            --no-apps) apps=0 ;;
            --no-start) start=0 ;;
            --help|-h) usage; return ;;
            *) die "Unknown option: $1" ;;
        esac
        shift
    done
    platform
    detect_user
    umask 022
    work=$(mktemp -d /tmp/koya-install.XXXXXX)
    chmod 0755 "$work" # Build as the login user even when invoked from root.
    trap cleanup 0
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    get_source
    package_inputs
    say "Installing for $login_user (UID $login_uid), $arch, profile $profile."
    [ "$profile" != generic ] || say 'Generic profile: retaining the base image GPU/audio/device configuration.'
    install_packages
    prepare_deployment
    prepare_session_files
    configure_system
    select_session
    [ "$start" = 0 ] || wait_session
    say "Installed: $prefix/current"
    say "Release and installed package record: $release/install-record.txt"
    say "Settings: $prefix/current/session.conf and /etc/koya-shell/hyprland.conf"
    if [ "$start" = 0 ]; then say 'tinydm is stopped. Start it from root with: rc-service tinydm start';
    else say "tinydm started. Session log: $login_home/.local/state/tinydm.log"; fi
    say 'Test touch, wake/unlock, audio, keyboard, haptics and Wi-Fi on the device.'
}

main "$@"

#!/usr/bin/env bash
# Release-based Alpine development, sharing only the desktop socket/render nodes.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fail() { printf 'local-dev: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'HELP'
Usage: ./local-dev.sh [container options] [-- session options]
  --engine COMMAND         podman or docker; detected automatically
  --koya-version VERSION   Verified Alpine APK release; default 0.5.3-r888
                           'latest' resolves the publication page without cache
  --hyprland-version VER   Alpine package version; default 0.51.1-r1
  --image NAME             Local image tag; default koya-phone-dev:alpine3.23
  --no-image-build         Reuse an already built image
  --check                  Build and run development checks without a desktop
  --gpu DEVICE             Share this render device (repeatable); default all
                           /dev/dri/renderD* nodes accessible to your user
  --help                   Show this help
Examples:
  ./local-dev.sh
  ./local-dev.sh --koya-version latest -- --size 540x1170
  ./local-dev.sh --no-image-build -- --no-build
The image installs signed Koya release packages and all development dependencies.
HELP
}
engine= koya_version=0.5.3-r888 hyprland_version=0.51.1-r1 image=koya-phone-dev:alpine3.23 build_image=1 run_checks=0
gpus=() dev_args=()
need_value() { [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a value"; }
while (( $# )); do
    case "$1" in
        --engine) need_value "$@"; engine=$2; shift;;
        --koya-version) need_value "$@"; koya_version=$2; shift;;
        --hyprland-version) need_value "$@"; hyprland_version=$2; shift;;
        --image) need_value "$@"; image=$2; shift;;
        --gpu) need_value "$@"; gpus+=("$2"); shift;;
        --no-image-build) build_image=0;;
        --check) run_checks=1;;
        --help|-h) usage; exit;;
        --) shift; dev_args=("$@"); break;;
        *) fail "Unknown option: $1 (pass session options after --)";;
    esac
    shift
done
(( EUID != 0 )) || fail 'Run as your desktop user, without sudo.'
[[ "$koya_version" == latest || "$koya_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$ ]] || fail 'Use a Koya APK version such as 0.5.3-r888, or latest.'
[[ "$hyprland_version" =~ ^0\.51\.[0-9]+-r[0-9]+$ ]] || fail 'This checkout requires a Hyprland 0.51.x APK version.'
if [[ -z "$engine" ]]; then
    if command -v podman >/dev/null; then engine=podman;
    elif command -v docker >/dev/null; then engine=docker;
    else fail 'Install Podman or Docker.'; fi
fi
[[ "$engine" == podman || "$engine" == docker ]] || fail '--engine must be podman or docker.'
command -v "$engine" >/dev/null || fail "Missing $engine"
if (( run_checks )); then
    (( ${#dev_args[@]} == 0 && ${#gpus[@]} == 0 )) || fail '--check does not take session options or GPU devices.'
else
    [[ -n ${WAYLAND_DISPLAY:-} ]] || fail 'Run from a Linux Wayland desktop terminal.'
    socket=$WAYLAND_DISPLAY
    if [[ "$socket" != /* ]]; then socket=${XDG_RUNTIME_DIR:?Missing desktop runtime directory}/$socket; fi
    [[ -S "$socket" ]] || fail "Parent Wayland socket is unavailable: $socket"
    socket=$(realpath -- "$socket")
    if (( ${#gpus[@]} == 0 )); then
        shopt -s nullglob
        for gpu in /dev/dri/renderD*; do [[ -r "$gpu" && -w "$gpu" ]] && gpus+=("$gpu"); done
    fi
    (( ${#gpus[@]} )) || fail 'No accessible GPU render node; use --gpu /dev/dri/renderD128.'
    for gpu in "${gpus[@]}"; do
        [[ -c "$gpu" && -r "$gpu" && -w "$gpu" && "$gpu" == /dev/dri/renderD* ]] || fail "Not an accessible render device: $gpu"
    done
fi
if (( build_image )); then
    # Stage a small context so neither engine uploads build artifacts or .git.
    context=$(mktemp -d /tmp/koya-container-build.XXXXXX)
    trap 'rm -rf "$context"' EXIT
    mkdir -p "$context/dev"
    cp "$root/dev/install-koya-release.sh" "$context/dev/"
    cp "$root/dev/Containerfile" "$context/Containerfile"
    build_args=(build --tag "$image" --file "$context/Containerfile"
        --build-arg "KOYA_VERSION=$koya_version" --build-arg "HYPRLAND_VERSION=$hyprland_version"
        --build-arg "DEV_UID=$(id -u)" --build-arg "DEV_GID=$(id -g)")
    [[ "$koya_version" != latest ]] || build_args+=(--no-cache)
    "$engine" "${build_args[@]}" "$context"
    rm -rf "$context"
    trap - EXIT
fi
run_args=(run --rm --init --user "$(id -u):$(id -g)"
    --security-opt label=disable
    --mount "type=bind,src=$root,dst=/work/koya-phone")
if [[ "$engine" == podman ]]; then
    run_args+=(--userns=keep-id --group-add keep-groups)
else
    for gpu in "${gpus[@]}"; do run_args+=(--group-add "$(stat -c '%g' "$gpu")"); done
fi
if (( run_checks )); then
    exec "$engine" "${run_args[@]}" "$image" bash dev/check.sh /work/koya-phone/dev/.build/container
fi
run_args+=(--interactive --tty
    --mount "type=bind,src=$socket,dst=/tmp/host-wayland,ro"
    --env WAYLAND_DISPLAY=/tmp/host-wayland)
for gpu in "${gpus[@]}"; do run_args+=(--device "$gpu:$gpu:rw"); done
printf 'Starting Alpine development using %s.\n' "$image"
exec "$engine" "${run_args[@]}" "$image" bash dev/session.sh \
    --build-dir /work/koya-phone/dev/.build/container "${dev_args[@]}"

#!/usr/bin/env bash
# Image lifecycle checks using fake engines; no containers or network needed.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work=$(mktemp -d /tmp/koya-container-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat >"$work/bin/podman" <<'ENGINE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$KOYA_ENGINE_FIXTURE/calls"
case "$1" in
    image) [[ "$2" == inspect && -f "$KOYA_ENGINE_FIXTURE/image" ]];;
    build) touch "$KOYA_ENGINE_FIXTURE/image";;
    run) :;;
    *) exit 1;;
esac
ENGINE
chmod +x "$work/bin/podman"
cp "$work/bin/podman" "$work/bin/docker"
export PATH="$work/bin:$PATH"
for engine in podman docker; do
    export KOYA_ENGINE_FIXTURE=$work/$engine
    mkdir "$KOYA_ENGINE_FIXTURE"
    launch() { bash "$root/local-dev.sh" --engine "$engine" --check "$@"; }
    builds() { grep -c '^build ' "$KOYA_ENGINE_FIXTURE/calls"; }
    launch
    [[ $(builds) == 1 ]]
    grep '^build ' "$KOYA_ENGINE_FIXTURE/calls" | grep -q -- '--no-cache'
    launch
    launch --no-image-build
    [[ $(builds) == 1 ]]
    launch --rebuild-image
    [[ $(builds) == 2 ]]
    launch --koya-version 9.8.7-r9999
    [[ $(builds) == 3 ]]
    grep '^build ' "$KOYA_ENGINE_FIXTURE/calls" | tail -n 1 >"$work/pinned"
    grep -q -- 'KOYA_VERSION=9.8.7-r9999' "$work/pinned"
    ! grep -q -- '--no-cache' "$work/pinned"
    launch --hyprland-version 0.54.3-r0
    [[ $(builds) == 4 ]]
    launch --no-image-build --koya-version 9.8.7-r9999
    [[ $(builds) == 4 ]]
    rm "$KOYA_ENGINE_FIXTURE/image"
    runs=$(grep -c '^run ' "$KOYA_ENGINE_FIXTURE/calls")
    if launch --no-image-build >"$work/missing" 2>&1; then exit 1; fi
    grep -q 'Missing local image' "$work/missing"
    [[ $(grep -c '^run ' "$KOYA_ENGINE_FIXTURE/calls") == "$runs" ]]
    [[ $(builds) == 4 ]]
done
printf 'Container image reuse and explicit rebuild checks passed.\n'

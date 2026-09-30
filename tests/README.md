# Application integration tests

The assertions and D-Bus service fixtures run in Koya JavaScript. Bash creates
each private test session and uses `socat` for fake Hyprland IPC. The coordinator
and display adapter are the real application binaries compiled with their
existing test hooks. These tests create no windows and need no compositor or GPU.

Use a Koya installation that includes the D-Bus plugin's `exportObject`,
`unexportObject`, and `emitSignal` APIs and the windowless event-loop fix. The
development image installs the latest Koya release from its Alpine repository.
No Koya or Helix source checkout is required by the tests.

Install the native build dependencies and Bash, D-Bus, coreutils, util-linux,
`socat`, and GdkPixbuf with SVG/PNG loaders. Then run:

```bash
meson setup build -Dintegration_tests=true
meson compile -C build
KOYA_BIN=/path/to/installed/koya meson test -C build --print-errorlogs
```

`KOYA_BIN` defaults to `koya` on PATH. The runner finds plugins in the
installation's `lib/` directory and assets in `share/koya/assets/`. Set
`KOYA_PLUGIN_DIR` and `KOYA_ASSET_DIR` for installations with another layout.
Use the plugins supplied with that Koya installation.

Run one test directly with, for example:

```bash
KOYA_BIN=/path/to/installed/koya bash tests/run.sh session build
```

The suite covers session ownership and cleanup, button and lock policy,
keyboard supervision, battery/network status, Wi-Fi backend operations,
display/idle/desktop behavior, and shell preferences (validation, live changes,
persistence and failed writes). Both bus addresses point to a private test daemon;
power, network, keyboard, battery, and compositor behavior use local fixtures.

The existing `capture-*.js` scripts exercise rendered UI separately and require
a Wayland compositor.

`capture-rotation.js` runs in a private, single-output local-development session
with the updated Koya engine. It checks programmatic resizing, rotates through all four transforms, and checks
`windowResized` payloads and duplicate suppression, verifies shell-layer and
wallpaper-grid bounds, and confirms the persistent components keep their PIDs.
It restores the starting transform and writes `/tmp/koya-rotation.json`.

`rotation-integration` exercises the real system-D-Bus sensor client against a
private sensor service: all four orientations, orientation lock, settling rapid
changes, screen-off/sleep/inactive sensor release, absent sensors, denied claims,
device and proxy recovery, and cancelling a pending rotation when disabled.

`capture-auto-rotation.js` runs in the private graphical development session and
drives its mock accelerometer through all four orientations. It checks live
Settings/wallpaper geometry and unchanged shell processes, then changes the
Auto-rotate preference to test orientation lock and re-enabling. It restores the
sensor/preference and writes `/tmp/koya-auto-rotation.json`.

`update-service-integration` runs the real system updater on a private D-Bus,
with a fake Polkit authority and controlled installer. It requires Python 3 with
PyGObject (`py3-gobject3` in the Alpine dev image). It checks caller authorization,
denial, duplicate requests, GUI disconnection during authorization and during
installation, reconnecting, consecutive updates with surviving descendants,
installer failure and retry. No privileged service or phone is modified.

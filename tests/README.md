# Application integration tests

These tests run without a compositor or GPU. They use Koya, private DBus
sessions and simulated phone services.

Use the latest Koya release with its matching DBus, Hyprland and process
plugins. Install the native build dependencies plus Bash, DBus, coreutils,
util-linux, `socat`, GdkPixbuf with SVG/PNG loaders, and Python 3 with PyGObject.
The development container includes these dependencies.

```bash
meson setup build -Dintegration_tests=true
meson compile -C build
KOYA_BIN=/path/to/installed/koya meson test -C build --print-errorlogs
```

`KOYA_BIN` defaults to `koya` on PATH. The runner looks for plugins in the
installation's `lib/` directory and assets in `share/koya/assets/`. Set
`KOYA_PLUGIN_DIR` and `KOYA_ASSET_DIR` if your installation uses another layout.
To test changes in Helix, point `KOYA_PLUGIN_DIR` at its build's `helix-plugin/`
directory.

Run one test with:

```bash
KOYA_BIN=/path/to/installed/koya bash tests/run.sh session build
```

The suite covers session cleanup, buttons, display and idle behavior, keyboard,
notifications, authentication, Wi-Fi, battery/network status, rotation, settings
and updates. Hardware and system services use local fixtures; tests do not change
your desktop session or install software.

The `capture-*.js` scripts check rendered UI and require a Wayland compositor.
`capture-rotation.js` checks window and layer geometry through all four transforms
and writes `/tmp/koya-rotation.json`. `capture-auto-rotation.js` uses the local
session's mock accelerometer and writes `/tmp/koya-auto-rotation.json`. Both
restore the starting orientation and settings.

`capture-credentials.js` checks the shared password/PIN control in a normal
Wayland window. `capture-lock-screen.js` must run in a disposable private
compositor with `KOYA_TEST_PRIVATE_COMPOSITOR=1`; it exits without unlocking,
so stop that compositor after the capture.

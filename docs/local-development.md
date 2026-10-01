# Local development

`./local-dev.sh` starts an Alpine container and runs the live checkout in a
portrait Hyprland window within your Linux Wayland desktop. The environment,
native service mocks and their build and checks live under `dev/`. The launchers
use Bash and the mocks use C++. Development compiles the application's native
coordinator with hardware input capture disabled, using its own Meson project.

## Run in Alpine

The container workflow installs Koya and its matching DBus, Hyprland and process
plugins from the [Koya Alpine repository](https://developer.koya-ui.com/install/index.html#alpine-postmarketos-repository).
The setup authenticates the repository's public key with Koya's pinned signing
key; `apk` verifies the repository index and packages. The image supplies the
runtime, Hyprland and native development dependencies. The launcher and
repository setup use Bash; the mock phone services are native C++.

You need a Linux Wayland desktop, Podman or Docker, and read/write access to a
GPU render node under `/dev/dri/`. Rootless Podman uses `crun` to preserve your
device-access groups. Docker must be accessible to your desktop user. Run from
a desktop terminal without `sudo`:

```bash
./local-dev.sh
```

The default image uses Alpine **3.24**, Hyprland **0.54.3-r0** and the latest
Koya release available when the image is built. The first run builds the image;
subsequent runs reuse it and rebuild changed native sources.
The checkout is mounted at `/work/koya-phone`, so JavaScript and asset changes
are available immediately; press **F5** to reload the UI.

Pass session options after `--`:

```bash
./local-dev.sh -- --size 1080x2340
```

`--koya-version VERSION` requests a specific APK version, provided it is still
available in the repository. Explicit Koya or Hyprland version options trigger
an image build. Builds using `latest` disable image build caching to install the
current release. Koya and its plugins use the same version,
and must include the session-lock API.
Use `--hyprland-version` for another 0.54.x version available in Alpine 3.24's
repositories. The generated development configuration translates the phone's
0.51 rules to 0.54 syntax. Aquamarine **0.12.0** in this image includes the
nested Wayland frame-callback fix that prevents redraws stalling until focus
changes. Changing the Alpine base or Hyprland's minor version requires editing
`dev/Containerfile` and checking configuration compatibility.

To refresh the image and install the latest Koya release, or skip rebuilding
native components when launching:

```bash
./local-dev.sh --rebuild-image
./local-dev.sh -- --no-build
```

`--no-image-build` requires an existing image and skips building even when
version options are supplied. Reused images determine the installed versions.
`--engine podman` or `--engine docker` selects the container engine explicitly;
`--image NAME` selects a local image tag. `--gpu /dev/dri/renderD128` limits
render-device sharing instead of sharing all accessible render nodes.

Only the parent Wayland socket is mounted from the desktop runtime directory;
the container starts its own private D-Bus and nested Hyprland session. The
launcher shares GPU render devices and disables SELinux labels for this
container so it can access the socket and checkout. It does not use privileged
mode. The image includes Mesa drivers for Intel/AMD GPUs; proprietary NVIDIA
drivers need additional container integration.

Container builds and logs stay in `dev/.build/container/`, separately from
host builds. The image records installed Koya package versions and the repository
at `/usr/local/share/koya-release.txt`. Exit with **F12** or Ctrl+C; the temporary
container is removed while the image, checkout and logs are retained.

### Live rotation

The private development services include an orientation sensor. From a terminal
inside the nested session, simulate turning the phone with:

```sh
bash /work/koya-phone/dev/session.sh --control orientation left-up
```

Other values are `normal`, `bottom-up`, `right-up` and `undefined`. **Settings →
Screen & sleep → Auto-rotate** enables or locks orientation just as on the phone.
Hold each simulated orientation for one second before expecting a rotation.

To check the buffer ordering, run `tests/capture-rotation.js` with
`WAYLAND_DEBUG=1` in the private session and save its output to a log. Then run
`python3 tests/check-rotation-commits.py LOG` from the checkout. It checks that
viewport size changes on mapped windows arrive with a new buffer, including the
wallpaper layer, rather than stretching the previous frame.

Rebuild an older development image to install the current Koya release:

```bash
./local-dev.sh --rebuild-image
```

The image uses installed Koya release packages. A custom engine executable can
also be selected with `-- --koya FILE --plugins DIR
--assets DIR`; the file and directories must be accessible inside the container.

## Run on the host

For an environment with dependencies already installed, the internal session
runner can also run directly on the host.

### Requirements

- A Linux Wayland desktop with working GPU rendering and a parent compositor
  that supports nested Hyprland's Wayland backend.
- Hyprland **0.54.x**, matching the generated development configuration, with
  Aquamarine **0.10.0 or newer** for its nested Wayland frame-callback fix.
- A current Koya release with session-lock support and matching DBus, Hyprland, process and PAM plugins
  and engine assets. The runtime must be compatible with
  your host's architecture and C library. The published Alpine APKs work in the
  container environment described above.
- Bash, Meson, Ninja, pkg-config, a C/C++ compiler, GLib/GIO, libevdev, libudev, polkit, OpenSSL and PAM development libraries and Wayland client
  development headers. The runtime also needs `dbus-run-session`, `gdbus`,
  `setsid`, `timeout` and `realpath`.
- GdkPixbuf with SVG support for application icons.
- Optionally Squeekboard to display and test the on-screen keyboard. Without it,
  the shell's keyboard control is unavailable; your desktop keyboard still works.

With the dependencies installed, run from the checkout:

```bash
bash dev/session.sh
```

The launcher uses `koya` and `Hyprland` on PATH. It finds engine assets under
`share/koya/assets` and plugins under `lib` or `lib64` in Koya's installation
prefix, with system locations as fallbacks. `KOYA_BIN` or `--koya` selects
another installed executable.

For an installation in a custom location, set the paths explicitly:

```bash
bash dev/session.sh \
    --koya /opt/koya/bin/koya \
    --assets /opt/koya/share/koya/assets \
    --plugins /opt/koya/lib \
    --hyprland /opt/hyprland/bin/Hyprland
```

The first run builds into `dev/.build/host/`. Subsequent runs rebuild changed
native sources. Use `--no-build` when working only on JavaScript or assets. Use
`--size 1080x2340` to change the output's pixel dimensions. The default matches
the OnePlus 6: 1080×2280 pixels at scale 2, giving Koya a 540×1140 logical display.
The host window is half the output size (540×1140 desktop logical pixels by
default); desktop scaling then determines its displayed size. This does not
change the phone's resolution or UI layout. Custom output dimensions must be even.
`--keyboard` selects a Squeekboard executable outside PATH; otherwise it is detected
automatically. Run `bash dev/session.sh --help` for session options.

The development launcher loads a small Wayland sizing helper into Hyprland to
request the fixed half-size preview window from the parent desktop. This avoids
Aquamarine's 1280×720 fallback overriding the monitor configuration. The helper
does not load into Koya or its other child processes, and is not part of the
phone build. Rebuild existing development images once to add `wayland-dev`.

## Edit and reload

In the container workflow, pass session options after `--`, for example
`./local-dev.sh -- --size 1080x2340`. Native C++ changes require a rebuild and
relaunch; omit `--no-build` to build changed sources.

Click and drag with the mouse to exercise touch interactions. JavaScript and
assets are mounted directly from the checkout. After an edit, press **F5** to
restart the owned shell components and load the changed files. Rebuild and
relaunch to pick up native C++ changes.

| Key, with the nested window focused | Action |
| --- | --- |
| F5 | Restart shell components |
| F6 | Open the power menu |
| F7 | Simulate a short power press: screen off / wake to the lock screen |
| F8 | Send a sample notification |
| F9 / F10 | Simulate volume down / up |
| F12 | Exit the development compositor |

The container lock screen uses the development account password, **koya**.
In a host session, enter your host account password. Password/PIN enrollment
requires a real login and polkit service; the nested mock services do not
authorize account password changes.

Ctrl+C in the launching terminal also closes the session. Logs are retained in
`dev/.build/container/logs/<timestamp>-<pid>/` (or `dev/.build/host/logs/` for host
sessions), including compositor, service and component logs. Temporary runtime
files are removed when the session exits.

## Simulated phone features

The real Koya UI and native shell coordinator run against isolated services:

- Battery starts at 73%; brightness and volume changes update fixture state.
- Wi-Fi shows sample networks. Protected networks accept `test-password`.
  Scanning, radio toggling, connecting, disconnecting and forgetting profiles
  affect only that session's fixtures.
- Power-off and reboot are recorded in `services.log`. Suspend and haptics are
  disabled, and idle timeouts are disabled while developing.
- Notifications and application windows belong to the nested session. The app
  launcher lists installed desktop applications and a Wi-Fi entry using the
  selected Koya runtime. In container mode these are the container's installed
  applications. Host mode applications have access to your normal files.

The display adapter controls the nested compositor's outputs. The host's
display, network connections, audio volume and graphical session are not
reconfigured by the launcher. Physical button capture is compiled out.

## Check the development tooling

Build and check the development environment in the container, without a
Wayland desktop or GPU:

```bash
./local-dev.sh --check
```

Checks also reuse an existing image; use `--rebuild-image --check` to refresh it.
These Bash/native checks cover
private service contracts, mock power and Wi-Fi actions, installed release
discovery, startup, restart, cleanup and release verification. They use
simulated compositor IPC and UI clients. Visual rendering still needs an
interactive nested session.

With host dependencies installed, `bash dev/check.sh` builds and runs the same
checks in `dev/.build/host/`.

Application integration tests use Koya JavaScript and private D-Bus fixtures.
See [the test instructions](../tests/README.md) for their runtime requirements
and commands.

To regenerate editable icon textures with a host-built native renderer:

```bash
KOYA_ICON_RENDERER="$PWD/dev/.build/host/koya-render-icon" bash dev/tools/render-power-icons.sh
KOYA_ICON_RENDERER="$PWD/dev/.build/host/koya-render-icon" bash dev/tools/render-status-icons.sh
```

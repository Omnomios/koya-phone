# Installation baseline

[`install.sh`](../install.sh) is the **single POSIX shell installer** for a base
postmarketOS installation. It downloads the source, verifies Koya packages,
builds the native bridges and configures the Koya/Hyprland session without
depending on a previous shell setup. It requests sudo internally, falls back to
doas when sudo is absent, and also works directly from a root shell.

Once published on GitHub, run from a terminal as the intended graphical user:

```sh
curl -fsSL https://raw.githubusercontent.com/Omnomios/koya-phone/master/install.sh | sh
```

The base must already have working device/kernel integration, internet access,
curl, apk-tools 3 and permission to use sudo/doas. Run from a root shell with
`--user USER` if the user has no privilege helper. The installer supports aarch64
and x86_64; it detects the OnePlus 6 profile and otherwise retains the base
image's graphics/audio integration. Repository branches are retained. The current
Hyprland template requires an available 0.51.x package; unsupported repositories
fail dependency resolution rather than being mixed with another distro branch.

Useful variants:

```sh
# Build from an existing checkout; no GitHub download.
sh ./install.sh --source-dir . --user user

# Pin both source and engine for a reproducible deployment.
curl -fsSL https://raw.githubusercontent.com/Omnomios/koya-phone/master/install.sh |
    sh -s -- --ref COMMIT_OR_TAG --koya-version 0.5.3-r888

# Select the session but leave tinydm stopped for manual activation.
sh ./install.sh --source-dir . --no-start --no-apps
```

`--help` lists options, including `--repo`, `--prefix` and `--profile`. The default
deployment is `~/.local/share/koya-shell/releases/<timestamp>-<pid>`, selected by
its `current` symlink. System launchers use that stable path. Existing
`session.conf` and installed Hyprland tuning are preserved on reruns; the Koya
startup line is replaced once. Previous releases are retained, with no automatic
rollback or package pruning. Existing display managers stop only after downloads,
build and Hyprland syntax verification succeed. Networking services that are
already running are not restarted. The final startup check only reads the normal
session's process IDs and D-Bus readiness; it does not test suspend or operate UI.

The script defaults to the latest APK version advertised by Koya's official
installation page. Build 888 or newer is required for text-input-v3 and independent
D-Bus handles; older pins are rejected. It downloads **only** the engine, D-Bus plugin and process
plugin from the same release, verifies the pinned OpenPGP primary-key fingerprint
and each detached signature, then allows those verified standalone APKs through
APK's native signature check. The release's `install-record.txt` records source,
release, architecture, fingerprint and artifact SHA256 sums. Signature verification
uses a private temporary keyring and never imports into the user's keyring.

Installer validation includes offline checks (`sh tests/test-install.sh`) and a
fresh OnePlus 6 / postmarketOS v25.12 trial on 2026-09-28. The trial used the
download-and-pipe command, with fixes applied to the downloaded installer before
execution. Koya build 888 signatures, the native build, Hyprland configuration,
session readiness, Wi-Fi status, audio sinks, keyboard availability, brightness
discovery and haptic udev tagging passed. A reinstall cleaned up the previous
graphical cgroup and left one compositor/coordinator/keyboard; the app drawer and
power menu both became ready with an empty `LastError`. Physical touch, wake,
sound output and suspend/resume still require testing on the device.

The trial found three installer faults: URLs/default refs used the nonexistent
`main` branch instead of `master`; the official multi-key bundle was rejected
despite containing the pinned signing key; and stopping tinydm left the previous
Weston session alive in its elogind cgroup. The installer now imports only the
pinned key into its verification keyring and captures the old local graphical
session's cgroup before stopping display managers, cleaning up its remaining
processes with the kernel's `cgroup.kill`. SSH and background sessions are
excluded. Unsupported graphical cgroup layouts fail before stopping the session.

The device's battery gauge returned invalid kernel values (`capacity=13296`,
`voltage_now=65535000`, `temp=-2731`); the shell correctly reports an unknown
percentage. Comparing two OnePlus 6 phones with the same `6.16.7-sdm845` kernel
and `ti,bq27411` device-tree compatibility identified different fuel-gauge
DeviceType responses: `0x0421` on the working phone, `0x1141` on this phone.
The latter gave sensible voltage, temperature and charge when queried directly
using the bq27541 register layout; its exact chip model remains unconfirmed.

With user approval, the second phone's installed DTB at
`/boot/dtbs/qcom/sdm845-oneplus-enchilada.dtb` was patched at
`/soc@0/geniqup@ac0000/i2c@a88000/bq27441-battery@55`: only the `compatible`
property changed from `ti,bq27411` to `ti,bq27541` (two bytes). The original DTB
and boot image were backed up locally and in the phone's root-owned
`/home/user/koya-battery-backup-20260928-232432/`. `mkinitfs` regenerated and
flashed `boot_a`; after reboot the kernel exposed `bq27541-0` with 100% charge,
4.393 V and 22.9°C. Koya reported `BatteryPercent=100`, its core components were
ready and `LastError` was empty. This is a per-device compatibility workaround,
not an installer default: the `0x0421` phone keeps its original configuration,
and kernel package upgrades can replace the patched DTB.

`CanSuspend=challenge` was initially observed with several SSH sessions open;
after reboot it reported `yes`. The base SSH sleep inhibitor still applies while
connected, so physical suspend testing must close those connections first.

Update the package manifests and this document whenever a feature adds a
dependency or needs a system configuration change. Do not use `/etc/apk/world`
as the installer input: this development phone also has unrelated tools and
packages retained from earlier experiments.

## OnePlus 6 battery-gauge workaround

[`scripts/fix-battery-gauge.sh`](../scripts/fix-battery-gauge.sh) applies the
per-device DTB workaround described above. It runs independently of the shell
installer and defaults to inspection. On the phone, install its dependencies:

```sh
sudo apk add dtc i2c-tools
```

After the utility is published, download this single file and inspect the gauge:

```sh
curl -fSL https://raw.githubusercontent.com/Omnomios/koya-phone/master/scripts/fix-battery-gauge.sh -o /tmp/fix-battery-gauge.sh
sudo sh /tmp/fix-battery-gauge.sh --check
```

Apply when it reports that a patch is needed:

```sh
sudo sh /tmp/fix-battery-gauge.sh --apply
sudo reboot
```

The utility supports postmarketOS on the OnePlus 6 (`enchilada`). It queries the
gauge's DeviceType twice without unbinding the driver or writing gauge settings.
`0x0421` keeps `ti,bq27411`; `0x0541` and the observed `0x1141` can use
`ti,bq27541` after voltage, temperature and charge readings pass sanity checks.
Other IDs are rejected. The `0x1141` chip's exact model remains unconfirmed;
the workaround selects its tested register map. An already patched DTB is
left alone, including when `--apply` is used.

Before changing anything, `--apply` saves the source DTB, deployed DTB, boot image
and a record with SHA256 hashes under
`/var/lib/koya-shell/battery-gauge-backups/<timestamp>-<suffix>/`. It verifies that
only the two compatibility bytes change, then runs `mkinitfs`, which regenerates
and deploys the boot image using the phone's existing boot-deploy configuration.
**This writes the boot partition.** The utility never reboots automatically.
After reboot, run `--check` again and confirm normal readings in the shell.

If deployment fails, it attempts to restore the source DTB and reports the backup
path. Deployment may have partially written boot files or the partition; resolve
the error and successfully run `sudo mkinitfs` before rebooting. To undo a
successful patch on the same kernel, replace the source DTB with the backup's
`source.dtb`, then rebuild and reboot:

```sh
sudo cp /var/lib/koya-shell/battery-gauge-backups/BACKUP/source.dtb /boot/dtbs/qcom/sdm845-oneplus-enchilada.dtb
sudo mkinitfs
sudo reboot
```

Replace `BACKUP` with the directory printed by the utility. Kernel upgrades can
overwrite this change; rerun the check after an upgrade rather than restoring a
DTB from an older kernel. The shell deployment also includes the utility at
`~/.local/share/koya-shell/current/scripts/fix-battery-gauge.sh`.

The utility's offline tests cover gauge selection, unchanged reruns, byte-level
DTB validation, backups and deployment/restore failures
(`sh tests/test-battery-gauge.sh`; DTB checks require `dtc`). On the patched
second phone, both `--check` and `--apply` reported `0x1141` and sensible readings,
and all three boot-file hashes stayed unchanged.

Gauge access uses the combined transfers documented by
[i2c-tools](https://kernel.googlesource.com/pub/scm/utils/i2c-tools/i2c-tools/+/master/tools/i2ctransfer.8).
The utility is POSIX shell and needs no Python runtime.

## Observed platform

Audited on 2026-09-28:

| Item | Current environment |
| --- | --- |
| Device / architecture | OnePlus 6, `device-oneplus-enchilada`, aarch64 |
| OS | postmarketOS v25.12 |
| Repositories | postmarketOS v25.12; Alpine v3.23 main and community |
| Compositor | Hyprland `0.51.1-r1` |
| Engine and required plugins | Koya / Helix plugins `0.5.3-r888` |
| On-screen keyboard / idle client | Squeekboard `1.43.1-r2`; swayidle `1.9.0-r0` |
| GPU | `soc-qcom-vulkan`, resolving to `mesa-vulkan-freedreno` |
| Login | tinydm `1.3.0-r0`, user `user`, UID/GID 10000 |
| Checkout | `/home/user/koya-shell` |
| Scale / idle policy | 2×; lock/display off after 120 seconds; locked display off after 30 seconds; suspend after 180 seconds of confirmed display-off |

These are reference versions, not a promise that other distro/compositor versions
accept this configuration. Discover the login user, UID and home directory on the
target; do not hard-code 1000, 10000 or `/home/user`. Preserve the installed device
kernel, firmware and modem/audio integration from the base image.

The configured repository branches are:

```text
http://mirror.postmarketos.org/postmarketos/v25.12
http://dl-cdn.alpinelinux.org/alpine/v3.23/main
http://dl-cdn.alpinelinux.org/alpine/v3.23/community
```

## Package inputs

Each file contains one APK package name per line, with `#` comments. These are
direct requirements; APK should resolve their library dependencies.

| Manifest | Purpose |
| --- | --- |
| [runtime.list](../install/packages/runtime.list) | Compositor, login, power, input, keyboard, icons, notifications, audio, haptics and network services |
| [koya.list](../install/packages/koya.list) | Engine and the two native modules imported by the shell |
| [oneplus-enchilada.list](../install/packages/oneplus-enchilada.list) | Device profile and working Vulkan driver |
| [build.list](../install/packages/build.list) | Building the current repository on the target |
| [apps.list](../install/packages/apps.list) | Firefox, Alacritty terminal and system fonts |
| [test.list](../install/packages/test.list) | Optional automated development checks |

The installer consumes these files, ignoring comments and blank lines, and checks
availability before changing the session. curl/gnupg are bootstrapped first for
signature verification; runtime/build/device/apps and verified Koya APKs are then
installed in one transaction.
Installation of a built shell does not need `build.list` or `test.list`.

### Runtime dependency reasons

| Packages | Used for |
| --- | --- |
| `hyprland`, `swayidle` | Wayland composition, workspace/window control, DPMS and event-driven inactivity detection |
| `tinydm`, `tinydm-openrc` | Autologin and display-manager lifecycle; `autologin` is an APK dependency |
| `dbus`, `dbus-openrc` | System bus and one graphical session bus via `dbus-run-session` |
| `elogind`, `elogind-openrc`, `polkit-elogind`, `polkit-openrc` | Active-session tracking, authorized shutdown/restart/suspend, sleep inhibitors and session brightness writes |
| `eudev`, `eudev-openrc`, `libevdev` | Button discovery, exclusive grabs, battery/backlight events and active-seat device permissions |
| `glib` | Native GIO/D-Bus, desktop-entry launching and `gdbus` diagnostics |
| `setpriv`, `flock` | Parent-death signals and session singleton locks; both are separate APK packages |
| `squeekboard` | On-screen keyboard; GTK and related libraries are resolved by APK |
| `gdk-pixbuf`, `librsvg`, `hicolor-icon-theme` | Dynamically loaded icon rasterization, SVG loader and XDG theme fallback |
| `libnotify` | Native notifications from Firefox and other libnotify clients |
| `pulseaudio`, `pulseaudio-utils` | Existing user audio server, `pactl` volume commands and a sleeping event subscription from Koya |
| `feedbackd`, `feedbackd-udev`, `feedbackd-device-themes` | Session-bus motor feedback, active-seat haptic device access and phone-specific effects |
| NetworkManager packages, `wpa_supplicant` | Cached network status, Wi-Fi and WWAN integration |
| ModemManager packages | Cellular status, modem discovery rules and system D-Bus activation |

Do not rely only on linked-library dependencies: the shell opens GdkPixbuf at
runtime, its SVG support is a loader, and Firefox opens libnotify dynamically.
Those packages can be absent even when executables start successfully. Firefox
caches a failed libnotify lookup and must fully exit and reopen after installation.

The shell currently imports only `Module/dbus` and `Module/process`. HTTP, FFmpeg,
Hypr, PAM, SQLite, WebSocket and the aggregate `helix-plugins` package are installed
on this development phone but are not current shell requirements. PAM integration
is future work.

Wi-Fi settings uses these same modules to call NetworkManager directly on the
system bus. GLib's existing `gdbus` executable handles only manual session-bus
Squeekboard visibility. No nmcli parsing, extra network daemon or new package is
required. Network changes must be authorised for the active graphical login;
show permission failures instead of installing a broad Polkit override.

The shell font is bundled with Koya at
`/usr/share/koya/assets/fonts/SourceSans3-Regular.ttf`; there is no `test.ttf`
dependency. Optional application fonts are in `apps.list`.

Only `hicolor` is currently installed under `/usr/share/icons`. The native resolver
tries `Adwaita` first, then `hicolor`, app-local icons and the bundled fallback.
`adwaita-icon-theme` is available but is an optional appearance improvement, not
an observed dependency. `gsettings-desktop-schemas` is also optional: the shell
enables `org.gnome.desktop.a11y.applications screen-keyboard-enabled` only when that
schema exists. It was absent during this audit; manual Squeekboard control works.

Xwayland is disabled. Neither Xwayland, Qt dialog helpers nor a desktop portal is
required by the current shell. Portal support for applications is a separate
integration task, not implied by basic Firefox notifications.

### Koya downloads

`apk policy` reports the installed Koya packages only in the installed database;
none of the configured distro repositories supplies them. `/etc/apk/world` has
checksum constraints for the locally installed APKs. A clean install therefore
cannot simply run `apk add koya` against those repositories.

Koya is available via download; use matching aarch64 engine/plugin downloads as
an installer input. A distro repository is not a prerequisite. Follow the
[Koya installation reference](https://developer.koya-ui.com/install/index.html)
and verify the engine, D-Bus plugin and process plugin use compatible versions.
Record the release URL, version, verification and installation method in the
installer. Do not copy the development machine's world checksum constraints into
a fresh installation.

### Build options

The installer uses `-Dintegration_tests=false` and compiles only the deployment
binaries. Meson is a distribution-provided build tool; configuration and
bootstrapping are POSIX shell. Development builds can enable private Python
integration tests with `-Dintegration_tests=true`; those tests are not runtime
dependencies.

The Hyprland runtime uses `build/koya-session`, `build/koya-hyprland-display` and
`build/koya-launch-app`. `build/koya-render-icon` is a development asset tool;
committed PNG assets do not need regeneration during install. A future prebuilt
deployment must either retain these expected paths or update their callers.

## Services and user access

| Service / setting | Required result |
| --- | --- |
| OpenRC `dbus` | Running system bus |
| OpenRC `elogind` | Running login/session tracking; graphical login registered and active |
| OpenRC `polkit` | Running with the elogind backend |
| eudev startup | Existing postmarketOS udev lifecycle retained; input and battery events available |
| OpenRC `networkmanager` and its wpa_supplicant integration | Preserve existing working network configuration; no second Wi-Fi manager |
| ModemManager | `org.freedesktop.ModemManager1` available through its system D-Bus activation file or one managed service |
| feedbackd | `org.sigxcpu.Feedback` activated on the graphical session bus; device theme and udev rules installed |
| OpenRC `tinydm` | Selected display manager; enabled after all files are prepared |
| OpenRC `cgroups` | Available for display-manager process cleanup |

ModemManager is installed with a system D-Bus activation file and is not explicitly
listed in this phone's default runlevel. The coordinator watches service ownership
and recovers if it appears later. No modem was exposed during the earlier shell
status check, so a clean install must distinguish missing service from missing
device/modem support rather than assume the UI alone verifies cellular operation.

Preserve device services such as `pd-mapper`, `rmtfs`, `tqftpserv`, `q6voiced` and
modem-specific setup supplied by postmarketOS. Audio is supplied by the existing
base UI setup. On this phone PulseAudio 17.0 exposes speaker and headphone sinks,
with the speaker selected as the default during the audit. The OnePlus profile
includes `soc-qcom-pulseaudio` and its OpenRC integration; retain its device/UCM
configuration. Koya controls the existing user audio server using `pactl`; do not
start a second PulseAudio server or switch to PipeWire just to implement volume.

Keep feedbackd's udev rules and device themes. The reference phone exposes
`spmi_haptics`; `/usr/lib/udev/rules.d/72-feedbackd.rules` identifies it as
`FEEDBACKD_TYPE=vibra` and grants active-seat access via `uaccess`. Apply newly
installed rules to existing devices (or reboot) and refresh the graphical login.
feedbackd starts on demand over the session bus; no OpenRC service or independent
autostart is required. Koya requests the quiet `button-pressed` motor effect.

After installing `feedbackd-udev` on a running system, run from root before
starting/restarting the graphical session:

```sh
udevadm control --reload-rules
udevadm trigger --action=change --subsystem-match=input
udevadm settle
rc-service tinydm restart
```

Verify the haptic event node with `udevadm info --query=property --name=<device>`:
it must have `FEEDBACKD_TYPE=vibra`. Package presence and a successful D-Bus reply
do not establish motor availability. During this phone's setup the rule was
installed after boot and its haptic node had no feedbackd tag; restarting tinydm
alone did not refresh udev's device database. Discover the event node by its
device name; do not bake the observed `event4` number into the installer.

The reference backlight is `/sys/class/backlight/ae94000.dsi.0`, with a maximum of
1023. The coordinator discovers the target's device instead of hard-coding that
name or range. Writes use `org.freedesktop.login1.Session.SetBrightness` on the
coordinator's own graphical session. Keep sysfs root-owned; no root helper,
backlight group override or broad polkit rule is needed.

The login user currently belongs to `input`, `video`, `netdev` and `plugdev`.
Reproduce necessary device access on the target, especially read access to the
dedicated power/volume input nodes and GPU access. Use the target's actual groups
and device permissions; refresh the login after changing supplementary groups.
The installer adds these groups, and `render`/`audio` when present, without
changing device permissions or group ownership.

Set `/etc/conf.d/tinydm` to the discovered autologin UID and retain:

```sh
rc_cgroup_cleanup="yes"
AUTOLOGIN_UID=10000  # reference phone; substitute the target user's UID
```

Set `HandlePowerKey=ignore` in `/etc/elogind/logind.conf` so the shell owns short
press/hold behaviour. Check for another power-key handler such as acpid. Power
actions use elogind with `interactive=false`; validate `CanPowerOff` and `CanReboot`
are `yes` in an active graphical session. There is no prompt agent to satisfy
`challenge`. Local `/etc/polkit-1/rules.d` was unreadable during this audit, so the
exact local rule inventory remains unconfirmed. Do not assume an undocumented
authorization override is part of the baseline or grant broad permissions to
compensate for an incorrectly registered session.

## Files and startup chain

Use the target checkout/deployment path when generating files; the current paths
below are the reference installation. System files belong to root; the checkout,
cache, state and runtime files belong to the login user.

| Destination | Content / source |
| --- | --- |
| `/etc/koya-shell/hyprland.conf` | Render `hyprland.conf.in`, replacing `@SHELL_COMMAND@` with the absolute path to `scripts/run-hyprland-shell.sh` |
| `/usr/local/bin/start-koya-hyprland` | Executable wrapper invoking the deployed `start-hyprland.sh` |
| `/usr/share/wayland-sessions/koya-hyprland.desktop` | Wayland session with `Exec=dbus-run-session /usr/local/bin/start-koya-hyprland`, `Type=Application`, `DesktopNames=Hyprland;` |
| `/var/lib/tinydm/default-session.desktop` | Symlink to the Koya Hyprland session entry |
| `/etc/conf.d/tinydm` | Autologin UID and cgroup cleanup as above |
| `/etc/elogind/logind.conf` | `HandlePowerKey=ignore` |
| Deployment `session.conf` | Idle policy: `lock-seconds=120`, `lock-screen-seconds=30`, `suspend-seconds=180` |
| Deployment `applications/koya-wifi.desktop` | Render its `Exec` path to the deployed `scripts/run-wifi.sh`; the checkout-local launcher already reads it |

`session.conf` also has a `[volume]` section for button/indicator enablement,
step/ceiling, indicator position and timeout, locked-screen behaviour, and an
optional named output. Defaults follow the audio server's selected output.
`[brightness] minimum-percent=5` sets the swipe-down slider floor (1–30%).
`[haptics] enabled=true` and `minimum-interval-ms=45` configure touch/volume
feedback (spacing 0–1000ms). These settings are exposed in `GetState` and read by
Koya; device discovery and privileged brightness transport remain native.

The startup chain is:

```text
OpenRC tinydm → autologin → tinydm-run-session → dbus-run-session
  → start-koya-hyprland → start-hyprland.sh → Hyprland
    → exec-once scripts/run-hyprland-shell.sh → koya-hyprland-display
      → koya-session → Koya shell components and Squeekboard
```

Only this chain starts the shell. Do not add a Koya launcher to `.profile`, a
second compositor service, an independent Squeekboard autostart, or a separate
swayidle OpenRC service. The adapter owns swayidle and the coordinator owns the
keyboard. Starting the shell from SSH gives it the wrong session bus and login.

Automatic suspend needs no extra package. Render `[idle] suspend-seconds` in
`session.conf` (default 180, 0 disables it). Koya owns the one-shot delay after
confirmed display-off; the coordinator transports `Suspend(false)` and elogind's
sleep/resume signals. The active graphical session must be allowed to suspend
without an authentication dialog. Preserve normal Polkit and sleep inhibitors;
do not grant `suspend-ignore-inhibit` or configure a second idle-suspend service.
An inhibited or failed request is attempted once per screen-off cycle, with the
error in the session log/`GetState.LastError`. The development plugin's SSH sleep
inhibitor must be released by closing that connection before hardware testing.
All resumes currently show the visual lock screen. Calls/SMS wake and playback
inhibitors remain physical-device/application integration checks.

`start-hyprland.sh` creates `/tmp/<uid>-runtime-dir` with mode 0700 and sets
`XDG_SESSION_TYPE=wayland` and `XDG_CURRENT_DESKTOP=Hyprland`. It clears stale
display/compositor variables and holds `koya-compositor.lock`. The adapter holds
`koya-hyprland-bridge.lock` and the coordinator holds `koya-shell.lock`.
Parent-death signals and coordinator cleanup prevent duplicate sessions.

The current Hyprland template targets 0.51.x. It sets scale 2, persistent Home
workspace 1, maximized applications, no gaps/borders, application/workspace
animations, and no compositor animations on Koya layers. It disables Xwayland,
blur/shadows, Qt-helper warnings, ANR dialogs, update news and donation prompts.
Validate the rendered configuration with the installed Hyprland before selecting
the session. Later Hyprland versions may require a template update.

User cache and logs are created automatically, not copied from this phone:

- `~/.cache/koya/icons/`: rasterized app/notification icons.
- `~/.local/state/koya-shell/`: adapter, coordinator, component and keyboard logs.
- `~/.local/state/tinydm.log`: compositor/session output.
- `/tmp/<uid>-runtime-dir/koya-hyprland.state`: live adapter/coordinator PIDs,
  instance signature and session bus address. Read as data; never source it.

Keep application `.desktop` files and icons provided by their packages. The
checkout's `applications/koya-wifi.desktop` supplies the shell's Wi-Fi settings
app; render its absolute launcher path. No global installation of that entry is
needed. The launcher checks executables on discovery and launch, and refreshes
asynchronously on opening so removed applications disappear from the cached list.

## Installer sequence and completion checks

The script runs as the login user with internal privilege escalation, or directly
from a root shell. Builds and the graphical session run as the login user. There
is no dependency on an earlier session or a migration script.

1. Detect OS, architecture, device profile, login user and repositories. Resolve
   Koya artifacts, required package availability and compatible versions.
2. Install the selected package lists together with the device's Vulkan support.
   Prepare binaries/assets and confirm the two Koya native modules and bundled
   font exist.
3. Prepare services, user access, tinydm/elogind settings and all generated files.
   Verify the Hyprland config before selecting it.
4. Select the session, enable required services and start/restart tinydm once.
   A rerun should update the intended files without adding duplicate startup paths.
5. Check one compositor, one adapter, one coordinator and expected component
   processes. Confirm the old session exits on a display-manager restart.
6. On the graphical bus, check `org.koya.Shell1.GetState`: active session, ready
   persistent UI, `LastError` empty, shutdown/restart capability `yes`, keyboard
   available, and network/battery state appropriate to the device. Check
   `GetBrightness` discovers the backlight and the graphical bus can activate
   `org.sigxcpu.Feedback`. Check
   `org.freedesktop.Notifications.GetCapabilities` returns body/actions/persistence.
7. Test touch scaling, app launch/switch, keyboard, browser notification, power
   short press/hold, swipe unlock, both idle timeouts, swipe-down brightness,
   physical volume changes, touch/volume vibration, Wi-Fi scan/radio control,
   saved-network reconnect and a password-protected network join. Network changes
   stay user-driven during installation verification. Actual shutdown/restart
   stays a deliberate user test rather than an installer self-test.

Before calling this reproducible from a clean base, confirm the local
power-authorization configuration and run the whole sequence on a fresh image.
Package presence alone does not prove the setup works.

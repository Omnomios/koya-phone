# Technical reference

A session-owned native coordinator, `build/koya-session`, publishes hardware buttons
and shell state on the session D-Bus. Wallpaper, top bar, power menu, and swipe lock screen are separate
Koya processes. On Hyprland, the bottom navigation process also owns the app/desktop
drawers. Hyprland supplies composition, workspaces and application window control.

Hold the power button continuously for one second to open **Power off / Restart / Lock**. A short press locks and powers off the display; another short press wakes to the swipe screen. The menu covers the output with a dim backdrop;
Escape or tapping outside the buttons dismisses it. Keyboard Tab/arrow keys
select a button and Enter/Space activates it. The initial keyboard selection is Lock. Lock opens the swipe screen without switching the display off.
The three large square buttons use orange and warm cream icons on deep green,
referencing the Koya fish logo. Targets are 320px square on the phone, separated
by 40px, and rotate into a row on wide displays.
The menu uses Koya's native non-looping keyframes: 320ms fade/rise with a 55ms
stagger, 75ms touch compression, a 260ms release rebound, colour transitions,
and a 180ms dismissal fade. Interrupted gestures start from the current visual
pose. Animations leave layout and hit testing fixed, as documented in
[Koya UI foundations](https://developer.koya-ui.com/ui-foundations/index.html)
and [UI/Animation](https://developer.koya-ui.com/ui-animation/index.html).
There is no animation polling or idle animation. Dismissal normally completes
from the native animation callback; a bounded fallback prevents a stuck overlay.

Volume press, release, and repeat events are published. Koya's top-bar process
handles presses/repeats and controls the selected PulseAudio output, with a
temporary volume indicator on the left of the screen.
Swipe down from the top bar for brightness control above notifications. Shell
buttons and volume changes provide a short haptic cue through feedbackd.

The bottom bar is 72 logical pixels high. Each navigation button occupies its
full height, with 12 logical pixels between targets and no vertical dead strip;
the icons remain 27 logical pixels. At 2× on the OnePlus 6 this gives about 9 mm
of target height, following Google's [touch-target guidance](https://support.google.com/accessibility/android/answer/7101858?hl=en).
Android dp and Wayland logical pixels are not interchangeable; use physical
dimensions when reviewing targets on a different display.

The wallpaper fills the output. At the phone's 2x scale, the black top bar is 40 logical
pixels high (80 physical), with 20 logical pixels of side padding and a vertically
centered 24px, 24-hour clock. Power buttons are 160 logical pixels square with
20px gaps, retaining their previous 320px physical touch targets. The top-bar and lock-screen clocks each have a recurring
UI timer, scheduled at the next minute boundary; it only changes text when needed.
The coordinator waits on D-Bus, udev, and input file descriptors, with timers only
for holds, startup deadlines, retries, and recovery from a missing system bus.

## Install

After publishing to GitHub, run this from a terminal on a base postmarketOS image:

```sh
curl -fsSL https://raw.githubusercontent.com/Omnomios/koya-phone/main/install.sh | sh
```

The POSIX shell installer requests sudo internally (or doas), verifies the official
Koya APK signatures, installs dependencies, builds as the login user and selects
the Hyprland session. It retains the base image's device integration and existing
shell tuning. See [installation instructions](installation.md) for prerequisites,
version pinning, local-source installs and `--no-start`.

The installer has passed offline checks and a Hyprland-only build; a fresh-image
installation still needs testing. The current template targets Hyprland 0.51.x.

## Build and activate

The [installation baseline](installation.md) records package manifests,
services and system configuration. Keep it current when adding dependencies.

Alpine build dependencies, installed from a root shell:

```sh
apk add build-base meson ninja pkgconf glib-dev libevdev-dev eudev-dev
```

Build as the regular user:

```sh
meson setup build -Dintegration_tests=false  # first build only
meson compile -C build koya-session koya-hyprland-display koya-launch-app
```

Runtime requirements are listed in `install/packages/runtime.list` and
`install/packages/koya.list`, including Hyprland, swayidle, Koya's D-Bus/process
plugins, elogind and a graphical session bus. The installer configures tinydm
to start `start-hyprland.sh` through `dbus-run-session`. Hyprland's `exec-once`
starts the display adapter, which starts the coordinator and its UI components.

After rebuilding an already configured deployment, activate from a root shell:

```sh
rc-service tinydm restart
```

The session must inherit the graphical login's D-Bus, Wayland socket, runtime
directory and elogind membership. Keep `HandlePowerKey=ignore` so the shell owns
power-key behaviour. No system D-Bus policy or root shell daemon is installed.

Logs are in `~/.local/state/koya-shell/`, including `hyprland-display.log`,
`session.log`, `wallpaper.log`, `top-bar.log`, `navigation.log`, `power-menu.log`
and `lock-screen.log`. Compositor output is in `~/.local/state/tinydm.log`.

## Ownership and input

The coordinator holds `koya-shell.lock` in the runtime directory and exclusively
owns `org.koya.Shell1`. It execs Koya children without inherited lock descriptors.
Parent-death signals tie Hyprland → display adapter → coordinator → Koya together. Graceful shutdown
terminates and reaps children; a stuck child is killed after two seconds.
Persistent components get at most three restarts in a rolling 60-second window,
with a three-second delay. Every component must report readiness within 12 seconds.
The power menu is a singleton and is never automatically respawned after dismissal
or failure; a new hold or `ShowPowerMenu` can reopen it.

udev discovers devices by their identity, not an `eventN` number. Only
`pm8941_pwrkey` and `Volume keys` are accepted, and only if all their advertised keys
are power/volume keys. They are exclusively grabbed while the elogind session is
active. Generic keyboards, touchscreens, and headset buttons are excluded.
Losing activity, removing a device, or `SYN_DROPPED` cancels an in-progress hold.
Keys already held when acquiring or resynchronizing a device must be released
before they can trigger a hold. Repeats never restart the hold timer.

## D-Bus contract

Bus: session. Name/interface: `org.koya.Shell1`. Path: `/org/koya/Shell1`.

| Method | Arguments | Result / behavior |
| --- | --- | --- |
| `GetState` | none | `a{sv}` snapshot |
| `GetBrightness` | none | `a{sv}` with `Available`, `Device` and `Percent` (-1 when unavailable) from the kernel |
| `SetBrightness` | `u percent` | Active, unlocked, owned top bar only; 1–100%; returns actual brightness after elogind writes it |
| `ShowPowerMenu` | none | Opens one menu, only while the session is active |
| `DismissPowerMenu` | none | Closes the menu unless a power action is pending |
| `Lock` | none | Opens the visual swipe screen in the active session |
| `Unlock` | none | Accepts only the owned, visible lock-screen process |
| `Ready` | `s component` | Accepts only the owned component's D-Bus process ID |
| `PowerOff` / `Reboot` | none | Accepts only the active, owned menu's process ID |
| `Suspend` | none | Owned active top bar only, ready lock screen and confirmed display-off; noninteractive elogind request respecting inhibitors |
| `ShowDesktopView` | `s apps/desktops` | Opens or changes the singleton view, on unlocked Hyprland |
| `DismissDesktopView` | none | Closes the view; returns before reaping the calling client |
| `ToggleKeyboard` | none | Owned navigation toggles Squeekboard while unlocked; closes any drawer |
| `GetApplications` | none | `aa{sv}` launchable graphical desktop entries plus the shell Wi-Fi app |
| `ResolveIcon` | `s icon description` | Cached PNG texture from an XDG themed icon or local file |
| `GetDesktopState` | none | `a{sv}` with raw Hyprland JSON strings: `workspaces`, `clients`, `activeworkspace` |
| `LaunchApplication` | `s desktop ID, u workspace` | Owned navigation launches known entries; top bar may launch only `koya-wifi.desktop`; workspace 2–10000 |
| `SwitchDesktop` | `u workspace` | Selects desktop 1–10000 while unlocked |
| `FocusWindow` / `CloseWindow` | `s address` | Validated hexadecimal window address; normal close request |

`StateChanged(a{sv})` carries a full snapshot. Fields: `Active` (boolean),
`PowerMenuState` (`closed`, `starting`, `open`, `closing`, `pending`), `LastError`,
`CanPowerOff`, `CanReboot`, `CanSuspend`, `ScreenState` (`unlocked`, `locked`, `off`), and `<component>Status` / `<component>Pid` for
`wallpaper`, `top-bar`, `power-menu`, and `lock-screen`. Capability strings come from elogind.
`IdleLockSeconds` and `IdleScreenSeconds` expose the configured idle timeouts.
`IdleSuspendSeconds` configures the Koya-owned sleep delay. `DisplayOff` records
confirmed compositor DPMS-off; `SuspendPending` and `PreparingForSleep` relay
the request/lifecycle, and `ResumeCount` increments on elogind resume notifications.
`HapticsEnabled`, `HapticsMinIntervalMs` and `BrightnessMinPercent` expose the
device-control settings. `BrightnessChanged()` announces backlight udev events;
the visible brightness control reads the new value on demand.
Component statuses are `stopped`, `starting`, `ready`, `restarting`, or `failed`.
The `keyboard` component can also be `external` if Squeekboard already owns its bus name.

Battery and network fields are included in the same state dictionary:
`BatteryPresent`, `BatteryPercent` (-1 when unknown), `BatteryState`,
`ExternalPower`, `NetworkAvailable`, `NetworkState`, `NetworkConnectivity`,
`NetworkType`, `WifiState`, `WifiStrength` (-1 when unknown), `WifiSsid`,
`CellularState`, `CellularStrength`, `CellularTechnology`, and `CellularOperator`.
The native coordinator reads the battery once at startup and on `power_supply`
udev events. It watches NetworkManager and ModemManager through cached D-Bus
object managers, coalesces notifications, and emits only changed status snapshots.
Missing or restarting services clear their status and recover when available.
The shell does not initiate Wi-Fi scans, modem signal polling, or connectivity
checks. NetworkManager's [connectivity](https://networkmanager.dev/docs/api/latest/gdbus-org.freedesktop.NetworkManager.html#gdbus-property-org-freedesktop-NetworkManager.Connectivity)
and [AP strength](https://networkmanager.dev/docs/api/latest/gdbus-org.freedesktop.NetworkManager.AccessPoint.html#gdbus-property-org-freedesktop-NetworkManager-AccessPoint.Strength)
properties and ModemManager's registered network/access technology drive the icons.

`HardwareButton(a{sv})` contains `Button` (`power`, `volume-up`, `volume-down`)
and `State` (`pressed`, `released`, `repeat`). `HardwareButtonEvent(s)` remains as
a compatibility JSON mirror for external clients. Koya uses the typed dictionary
from `event.args[0]` with build 888's D-Bus module. The coordinator only forwards
the event; Koya owns volume behaviour.

`DesktopChanged()` is emitted from Hyprland window/workspace events or a desktop-entry
change. Fragmented event lines are buffered and bursts are coalesced on one GLib
idle callback. The UI requests a fresh snapshot on changes; it never polls.
`DesktopAvailable` and `DesktopView` (`closed`, `apps`, `desktops`) are in `GetState`,
along with navigation process status and PID fields. Navigation owns both drawers;
there is no separate desktop-view process.

Subscribe before requesting the initial state. `apps/session.js` does this and
refreshes on state/owner changes. A lost coordinator ends its owned clients;
a replacement session starts fresh clients. The coordinator reconnects to an
unavailable system bus and watches elogind ownership and session activity.
Start native D-Bus calls after Koya bootstrap returns: its promises require the
engine's event loop. Do not await `Bus.connect` inside the bootstrap function.

Power requests recheck `CanPowerOff` / `CanReboot` and call elogind's corresponding
method with `interactive=false`. `challenge`, `no`, inactive sessions, inhibitors,
and service failures are reported without authorizing through a prompt. Failed
actions keep the menu open for retry/cancel. Successful requests remain pending
while the system shuts down, preventing duplicate requests.

## Volume controls

Volume buttons adjust the selected PulseAudio output by five percentage points.
Holding a button handles the device's repeat events; release does not change
volume. Levels stay between zero and the configured maximum (100% by default),
preserving channel balance. Volume up also unmutes the output. The compact left
indicator uses the shell's cream speaker icon, orange level and deep green
surface, with an entrance fade/slide and a short pulse on level changes. It does
not take focus or intercept touches.

Configure `[volume]` in `session.conf`, then restart tinydm:

| Setting | Default | Meaning |
| --- | --- | --- |
| `buttons-enabled` | `true` | Enable physical volume control |
| `indicator-enabled` | `true` | Show the temporary indicator |
| `step-percent` | `5` | Percentage points per press/repeat, 1–25 |
| `maximum-percent` | `100` | Output ceiling, 1–100 |
| `timeout-ms` | `1800` | Indicator duration since the last change, 300–10000ms |
| `side` | `left` | `left` or `right` |
| `margin` | `16` | Distance from that edge, 0–100 logical pixels |
| `position-percent` | `50` | Vertical position between the top and bottom bars, 0–100 |
| `while-locked` | `true` | Allow buttons while locked/off |
| `sink` | empty | Follow default output; optionally pin a PulseAudio sink name |

The screen stays off when changing volume while off. The indicator hides for
session inactivity and power menus. A missing output shows an unavailable icon
and writes the detailed error to `top-bar.log`.

`apps/pulse-audio.js` uses the existing Koya `Module/process` API for asynchronous
`pactl` commands and one persistent `pactl subscribe` stream. Audio state comes
from PulseAudio; button policy and the UI cache live in Koya. External output
volume/mute changes and default-output changes refresh the UI through that stream,
without polling. Subscription recovery has three bounded retries; another press
can retry later. The indicator is another top-bar window, parked transparent with
rendering disabled when hidden. No additional native audio state or Koya process
was added.

Runtime dependency: `pulseaudio-utils`; keep the device's working PulseAudio/UCM
setup. The OnePlus profile records its Qualcomm audio packages. This first step
controls output volume; app-specific levels, call routing and microphone control
are separate work.

## Brightness and haptics

Swipe down from the top bar, even with no notifications, to show the brightness
slider. Its 72-logical-pixel touch area supports tapping and dragging. Changes
appear immediately while asynchronous writes are coalesced to the latest value.
The default minimum is 5%; display power-off remains the power button/idle policy.

Brightness state and interaction live in `apps/brightness.js`. The native layer
discovers `/sys/class/backlight`, reads its current value on request and forwards
writes to the graphical session's elogind `SetBrightness` API. It adds no root
helper, sysfs permission changes, cached brightness or polling loop. Missing
backlight support leaves the slider unavailable; failed writes restore the actual
value and log the error in `top-bar.log`.

`apps/haptics.js` sends one-shot `button-pressed` events over the graphical session
bus to feedbackd, using its quiet profile for motor feedback without audio.
Touch-down on shell buttons triggers the cue; volume feedback fires only when the
level or mute state actually changes. Requests never block the touch animation.
A timestamp limit suppresses bursts, and failed requests have a bounded retry
cooldown without a timer or background loop.

Configure `session.conf`, then restart tinydm:

| Section / setting | Default | Meaning |
| --- | --- | --- |
| `[brightness] minimum-percent` | `5` | Slider minimum, 1–30% |
| `[haptics] enabled` | `true` | Enable shell touch/volume feedback |
| `[haptics] minimum-interval-ms` | `45` | Minimum spacing between requests per Koya process, 0–1000ms |

Runtime packages: `feedbackd`, `feedbackd-udev`, `feedbackd-device-themes`.
feedbackd activates on the session bus; do not supervise another instance.
On the OnePlus 6, the installed udev rule identifies `spmi_haptics`, grants active
seat access with `uaccess`, and the device theme inherits the default motor effects.
Retain device-specific rules/themes on other phones. No extra Koya process or
native haptics module is needed.
If the rules were installed after boot, reload and retrigger udev before restarting
the session, as shown in the [installation baseline](installation.md).
The haptic event node must have `FEEDBACKD_TYPE=vibra`; an accepted feedback request
can otherwise finish without any vibration.

## Notifications

Firefox and other libnotify clients need the `libnotify` runtime package. Firefox
loads this library dynamically; a working notification service alone does not
enable its native notifications. Install it from a root shell, then fully quit
and reopen Firefox (it caches a failed library lookup):

```sh
apk add libnotify
```

Koya's top-bar process owns notification state and both notification windows.
Tap anywhere on the top bar or swipe down to open the panel. A single target
covers the full bar, including icons and side padding; downward movement of six
logical pixels opens it, including when the finger leaves the bar. The bell is hidden
when the notification list is empty and turns orange when notifications are
unread. Banners fade and move into place below the
bar, without taking keyboard focus. The panel uses the same cream typography,
orange accents, deep green surfaces and generous touch targets as the shell.
It provides per-card dismissal, application actions, clear-all, and pages when
the list exceeds the screen. App icons come from the notification's icon name or
desktop entry, with a shell bell fallback.

The service implements the standard
[desktop notification interface](https://specifications.freedesktop.org/notification/latest/protocol.html)
at `org.freedesktop.Notifications` on the session bus. It supports `Notify`,
replacement IDs, `CloseNotification`, `GetCapabilities`, `GetServerInformation`,
`ActionInvoked` and `NotificationClosed`. Capabilities are `body`, `actions` and
`persistence`. Ordinary notifications with the default timeout remain until
dismissed; their banners hide after five seconds (eight for critical urgency).
Explicit application expiry is honoured, with passive history retained unless
the notification is transient. Resident actions preserve their notification.
History is limited to 100 records and lasts for this Koya process's lifetime.
There is no disk history, notification sound, or raw image-data support yet.

All IDs, content, timers, unread flags, actions and history live in
`apps/notifications-model.js`. The installed D-Bus module exposes only client
operations, so `native/notification-transport.hpp` supplies the missing server
transport: it claims the standard name, forwards requests to the registered
top-bar connection, returns Koya's replies, and emits Koya's requested signals.
It stores only pending RPC invocations, with bounded deadlines, and releases the
service name if the frontend exits. Native `ResolveIcon` reuses the platform icon
resolver; it holds no notification state. An existing notification server is
left in control if it already owns the standard bus name.

Notifications do not wake the display and their contents stay hidden while
locked or inactive. The notification panel closes for locking, power menus and
application drawers. Hidden notification surfaces are transparent, input-free,
and have rendering disabled. Native keyframes provide entrance, dismissal and
press feedback; no animation polling or recurring notification timers are used.

## Wi-Fi settings

Open **Wi-Fi** from the swipe-down panel or app launcher. The shortcut focuses
an existing Wi-Fi window, or starts it on a new desktop. The panel closes after
launch. The app uses the shell's cream/orange/green style, 72px network targets,
press feedback, and a password sheet above the keyboard.

The app lists nearby SSIDs with signal strength, security and connection state.
Connected rows have a Disconnect button; saved networks also have a Forget button
which removes their saved profile. Selecting the network itself never disconnects
it. NetworkManager
first chooses a compatible saved profile. If a personal network needs credentials,
enter its password and tap Connect. The field is masked, with optional Show/hide
and Paste controls. Tapping the field gives it an orange outline and a native
blinking caret, and activates Squeekboard through text-input-v3. The blink stops
on submission or dismissal. Unsaved protected networks open the sheet without
attempting a connection; credential errors appear only after Connect is pressed.
Closing the sheet restores the cached list immediately while keyboard dismissal
runs independently.
IME commits, preedit and UTF-8 byte deletion are handled by the password field;
password content is never sent as surrounding text. Refresh requests a scan, and On/Off controls the
Wi-Fi radio. New profiles use automatic IP configuration and are restricted to
the login user; NetworkManager saves their credentials for future connections.
Retries in the same app instance update its newly created profile instead of
creating another copy. Existing profiles are not overwritten by the simple form.

`apps/wifi-network.js` calls NetworkManager directly through `Module/dbus`:
`GetDevices`, property reads, `RequestScan`, `ActivateConnection`,
`AddAndActivateConnection`, profile `Update` / `Delete`, device `Disconnect` and the radio
property setter. See the [NetworkManager API](https://networkmanager.dev/docs/api/latest/gdbus-org.freedesktop.NetworkManager.html)
and [Wi-Fi device API](https://networkmanager.dev/docs/api/latest/gdbus-org.freedesktop.NetworkManager.Device.Wireless.html).
Koya owns the UI cache, pending actions, password form and scan deadlines. Status
updates arrive through D-Bus signals, with coalesced asynchronous reads and no
periodic scans or idle polling. Normal NetworkManager/Polkit session permissions
apply; an authorization failure is shown in the app.

The Wi-Fi app uses the independent `Module/dbus.system` handle. Shell components
use `Module/dbus.session`, which Wi-Fi also uses for keyboard visibility if the
compositor lacks text-input-v3. There is no subprocess keyboard helper. The native
coordinator only permits the owned top-bar shortcut to launch this particular app;
it holds no Wi-Fi UI state or credential payloads. No new package or daemon is
needed. The installer renders the launcher's absolute deployment path.

This first version supports visible open, WPA/WPA2 personal, WPA3 personal and
OWE networks. Hidden-SSID entry, enterprise credentials/certificates, WEP,
hotspots, VPNs and custom IP configuration are not implemented. Profiles and
network access remain NetworkManager's responsibility. The form clears its
password on close/submission; secrets never enter shell command arguments and
the Wi-Fi wrapper disables optional D-Bus wire tracing.

Known installed-plugin workarounds and reproduction details are recorded in
[D-Bus plugin issues](dbus-plugin-issues.md).

## On-screen keyboard

On Hyprland, the coordinator starts one persistent `/usr/bin/squeekboard` after
navigation is ready, supervises it with the same bounded restart policy as shell
components, and terminates it with the session. If Squeekboard is already running
on the session bus, it attaches to that instance instead of starting a duplicate.
Logs are in `~/.local/state/koya-shell/keyboard.log`.

The fourth navigation button toggles the keyboard and turns orange while it is
visible. Squeekboard handles automatic activation from compatible applications
through Wayland. The coordinator enables the GNOME accessibility setting
`org.gnome.desktop.a11y.applications screen-keyboard-enabled` when its schema is
installed. Koya build 888 exposes `Compositor.setTextInput` for editable focus and
`textInputMethod` events for input-method edits; the Wi-Fi form uses those APIs.

The shell hides the keyboard on Home, drawer opening, power-menu opening, locking,
and session deactivation. It also rejects automatic activation while a shell
overlay is open or the screen is locked/off. Visibility is read from Squeekboard's
`sm.puri.OSK0.Visible` property and changed using its asynchronous `SetVisible(b)`
method; there is no keyboard polling. Rapid manual presses are coalesced, including
a hide request arriving before a show completes. `GetState` exposes
`KeyboardAvailable`, `KeyboardVisible`, `KeyboardPending`, `keyboardStatus`, and
`keyboardPid`. See [Squeekboard's D-Bus documentation](https://world.pages.gitlab.gnome.org/Phosh/squeekboard/hacking.html).

Squeekboard's layer surface reserves its own keyboard space; navigation maps
first and reserves the bottom strip. Keyboard theme defaults to `Adwaita:dark`
and follows compositor scaling.

The focused lifecycle/visibility test uses a private bus and fake compositor:

```sh
meson test -C build keyboard-integration --print-errorlogs
```

## Validation

Optional development dependencies are Python 3, `py3-gobject3` and D-Bus.
Enable integration tests when configuring a development build:

```sh
meson configure build -Dintegration_tests=true
meson compile -C build
meson test -C build --print-errorlogs
```

The native tests use private buses, mock elogind and fake compositor IPC/input
notifications. They cover input holds, caller ownership, singleton processes,
bounded recovery, status, keyboard visibility, display power and idle policy.
They never invoke host power methods or grab physical input devices. Input
injection exists only in the separate `koya-session-test` binary.

The installer also has an offline check:

```sh
sh tests/test-install.sh
```

Koya capture scripts and private service fixtures remain under `tests/`; the
previous compositor smoke runners have been retired. Check touch, animations,
application launch and real device power behaviour on the phone after activation.

The shell uses `/rom/fonts/SourceSans3-Regular.ttf`. Koya's `Helix/Profiler`
provides `setEnabled`, `reset` and `snapshot`. Timings include blocking waits,
so sleeping time is not CPU time. Recurring profiler reporting is not enabled.

## Hyprland session

The installed config is `/etc/koya-shell/hyprland.conf`, rendered from
`hyprland.conf.in` by the installer. It targets Hyprland 0.51.x, sets scale 2,
maximizes applications and keeps desktop 1 as Home. Application/workspace
transitions are enabled; Koya owns its layer animations. Xwayland, blur/shadows,
Qt-helper warnings, unresponsive-app dialogs and update/donation prompts are
disabled. Keyboard test bindings include Super+Q and Super+1/2/3.

`start-hyprland.sh` holds `koya-compositor.lock`. The native display adapter
uses Hyprland's Unix command socket for DPMS and owns one swayidle instance for
input inactivity. Idle expiry carries a generation token; policy changes and
grabbed hardware-key activity rearm the timer without polling. Compositor
disconnect stops the coordinator and its children; coordinator disconnect
restores display power. The runtime adapter and launch scripts need no Python.

## Applications and desktops

Build with `meson compile -C build` as the regular user. During development, render
the config template as the regular user:

```sh
sed 's|@SHELL_COMMAND@|/home/user/koya-shell/scripts/run-hyprland-shell.sh|' hyprland.conf.in > /tmp/koya-hyprland-new.conf
```

Then apply it directly and restart from a **root shell**:

```sh
cp /tmp/koya-hyprland-new.conf /etc/koya-shell/hyprland.conf
rc-service tinydm restart
```

The installer renders this template automatically and preserves existing tuning
on reruns.

The bottom bar has Apps, Home and Desktops controls. Apps reads standard XDG
desktop entries through GIO, respects hidden entries and desktop visibility, and
adds the shell's Wi-Fi settings entry. It checks `TryExec` or the `Exec` executable
on discovery and again before launch, while supporting D-Bus-activated apps.
Opening Apps shows the cached list immediately and refreshes asynchronously, so
removed executables disappear without delaying presentation. Console-only
`Terminal=true` entries are omitted. Selecting an app
focuses a matching open window when its desktop class/executable identifies it;
otherwise it launches on an unused numbered desktop starting at 2. Desktop 1
remains Home and is omitted from the desktop overview; the bottom bar provides
the Home control. Secondary windows/dialogs may share their application's desktop.

The black top bar retains its 24-hour clock on the left. The right side shows
Wi-Fi strength, cellular bars and 2G/3G/4G/5G when registered, battery percentage,
and an orange charging bolt. Low battery and limited/captive connectivity use
orange accents. Unavailable radios and unknown battery readings are shown without
inventing signal strength or a zero percent charge. Service updates change only
the affected text/icon; there are no status polling timers or idle animations.
Editable SVGs and generated PNGs live in `assets/status`; regenerate them with
`sh scripts/render-status-icons.sh`. A focused provider check is available with
`meson test -C build status-integration`.

Apps uses an open icon grid with a single app-name label. The overview groups real
Hyprland windows by desktop, highlights the current app name in orange, and offers
focus and an icon close control. Desktop buttons use a compact icon-and-name grid
without a button background; there are no screenshot previews yet.
The bottom bar uses Apps/Home/Desktops icons.
Both views have touch-sized targets, pagination only when needed, native fade/rise
transitions and press/release motion with fixed layout hit testing. The bottom bar
process owns Apps and Desktops as additional windows, stays connected to D-Bus and
caches application metadata. It prepares one drawer window at startup and reuses
it. Closing, locking, or opening the power menu releases input, commits a fully
transparent buffer, then disables drawer rendering. Its refresh indicator and
waiting animations stop while hidden. Opening uses one native entrance animation;
there is no window creation on a normal tap. Data-driven rebuilding waits for the
entrance to finish and retains the previous buffer while the replacement is built.
Opening a drawer bounces its navigation icon until the window is ready. Launching
an app keeps the drawer visible and bounces the selected tile until a Hyprland
window event identifies its new surface, then focuses it and dismisses the drawer.
These waiting animations run in Koya; there is no JavaScript polling or frame loop.

The coordinator reads each desktop entry's `GIcon`, resolving absolute paths or
icon names through XDG icon directories, theme inheritance, hicolor and pixmaps.
`KOYA_ICON_THEME` selects a theme (default Adwaita, falling back to hicolor).
Lookup follows the [freedesktop icon theme specification](https://specifications.freedesktop.org/icon-theme/latest/).
The installed GdkPixbuf/librsvg loaders render PNG, SVG and XPM sources into
transparent 160px PNGs under `$XDG_CACHE_HOME/koya/icons` (normally `~/.cache/koya/icons`).
Source path and modification time identify cached textures. Cache contents are
prepared before starting navigation and mounted into Koya's `/rom` assets.
Bundled icons cover missing terminal/touchpad icons and a generic app fallback.
No icon scanning or conversion runs on an interval. `ApplicationsChanged` refreshes
the app cache and reindexes the icon mount when desktop entries change. Window
events refresh the cached desktop snapshot while the session is unlocked; queries
pause while locked or the screen is off. Opening immediately shows the cached
contents and starts an asynchronous refresh. A small orange dot pulses beside the
title until the refresh finishes. Refreshing never blocks the window lifecycle
queue. Native snapshot IPC runs in a GTask worker so the coordinator can continue
handling hardware buttons, visibility and dismissal during slow replies.
`DesktopViewMapped` reports whether the owned UI has an overlay window.

Set `KOYA_DESKTOP_TRACE_FILE` to a writable JSON path before starting the session
to record bootstrap, query, window creation and layout timestamps. This tracing is
disabled by default and adds no periodic work.

The coordinator listens directly to Hyprland's event socket and publishes changes
over D-Bus. The Koya Hyprland plugin and periodic JS queries are not used. Snapshot
queries and commands have a 300ms deadline per IPC connection. The native launch
helper uses GIO's desktop-file parser and field-code handling; filenames are shell
quoted when invoking the helper through Hyprland. Startup errors are recorded in
`~/.local/state/koya-shell/applications.log`. `initial_workspace_tracking=2`
keeps the workspace token with launched child processes. Applications activated
through an existing D-Bus service may need additional activation handling.

At scale 2, Koya's window dimensions and touch coordinates are logical pixels;
the 540x1140 phone surface has a 1080x2280 buffer. `apps/theme.js` defines the bar
sizes. Menu, clock, lock text and swipe distances use the corresponding logical
sizes. External output/config changes require restarting this version of the shell.

The native Hyprland integration test verifies discovery, hidden entries,
window-address validation, launch
ownership, singleton views, fragmented event delivery and cleanup. Physical
touch and app startup on Hyprland remain phone checks after the session restart.

## Display power and swipe screen

`build/koya-hyprland-display` switches real panel power through Hyprland's DPMS
dispatcher. Public state and controls remain on `org.koya.Shell1`; the coordinator
communicates with the adapter through the same-user Unix socket
`$XDG_RUNTIME_DIR/koya-display.sock`. A failed power request reports an error;
disconnect restores output power. Display-off saves panel power; automatic system
suspend is a separate policy described below.

The coordinator waits for lock-screen readiness before switching the display off.
A short power press toggles display power, waking to the swipe screen. A long
press wakes an off display and opens the power menu; releasing it does not toggle
power again.

The lock screen uses native fade/rise animations, text that follows the swipe,
a stationary wallpaper that zooms up to 3.5% about its centre, cancelled-swipe
return and an exit fade. Upward travel must exceed 14% of screen height
(100–240 logical pixels), with limited sideways travel. Taps, downward and short
swipes do not unlock. The clock changes at minute boundaries without an idle
animation loop.

This is a visual layer-shell overlay with swipe dismissal. Authentication and
compositor-enforced locking with ext-session-lock/PAM are future work.

## Idle timeouts

`session.conf` configures `lock-seconds` (default 120) for normal use and
`lock-screen-seconds` (default 30) while the swipe screen is visible. Normal idle
locks and powers off the panel. Waking starts the shorter lock-screen timer;
swiping to unlock restores the normal timeout. Values are whole seconds from
0 to 86400; 0 disables that timeout. Restart tinydm from a root shell after editing.

The adapter owns swayidle, which observes compositor input inactivity across
clients. Grabbed power/volume activity rearms it through the coordinator. UI
redraws, clock changes and D-Bus state updates do not reset idle time. Screen-off,
inactive sessions and pending power actions disable the timer. Generation tokens
reject stale expiry after wake or policy changes. There is no polling loop or
independent swayidle service.

`tests/test-hyprland.py` checks the adapter/coordinator protocol using private
compositor IPC and idle notifications without changing the phone's panel state.

## Automatic suspend

`[idle] suspend-seconds=180` in `session.conf` starts a single Koya timer after
the display has been confirmed off and the visual lock screen is ready. Values
are seconds, 0–86400; 0 disables automatic suspend. Waking, losing the active
session or losing display/lock readiness cancels the timer. Other status changes
do not restart it. The top bar owns this policy in `apps/suspend.js`; there is no
native sleep timer or periodic inhibitor query.

At expiry, the owned top bar calls `Suspend`. The coordinator checks authorization
using the graphical session's `CanSuspend`, rechecks display/session readiness,
then calls elogind `Suspend(false)`. Authentication dialogs are not requested and
sleep inhibitors are not bypassed. An error is logged and exposed as `LastError`;
Koya makes no further attempt until a new screen-off cycle. It does not stop
applications, kill networking or write to `/sys/power/state` itself.

`PrepareForSleep(true)` dismisses drawers/keyboard and keeps the visual lock over
applications. `PrepareForSleep(false)` restores the locked display, refreshes
capabilities and restarts the shorter lock-screen display timeout. The waking
power-button press/release is consumed for 750ms so it cannot immediately toggle
the display off. All resumes currently reveal the lock screen, including wakes
from sources other than the power button. The lock is still a visual prototype.

No suspend or on-device integration harness was run for this change; the native
coordinator was compiled. After a root `rc-service tinydm restart`, test power
button wake, display recovery, network/modem reconnection and battery drain on
the physical phone. An existing inhibitor named `sleep-inhibitor`, with reason
`Plugin SSH session open`, blocks sleep during the development connection. Do
not remove or override it while the harness is connected. Test with that session
closed, and check sleep/wake support for calls/SMS and app-provided audio/call
inhibitors separately. Automatic suspend respects registered inhibitors; it does
not infer an inhibitor from audio playback itself.

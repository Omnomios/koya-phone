# Using Koya Phone

## Controls

| Action | Control |
| --- | --- |
| Open an app | Tap **Apps** on the bottom bar, then the app |
| Return home | Tap **Home** |
| Switch or close an app | Tap **Desktops** |
| Show or hide the keyboard | Tap the keyboard button |
| Change wallpaper or shell preferences | Open **Settings** from **Apps** |
| Update the shell | Open **Update Koya** from **Apps** |
| Open notifications and brightness controls | Tap the top bar or swipe down from it |
| Switch the screen off or wake it | Press the power button briefly |
| Open Power off, Restart and Lock | Hold the power button |
| Unlock | Enter your password or PIN |
| Adjust volume | Press or hold a volume button |

The lock screen authenticates your Linux account through PAM. Choose password
or PIN entry in **Settings → Password & PIN**.

Each app opens on its own desktop. Selecting an app that is already open returns
to its window. Use **Desktops** to switch between apps or close their windows.

The keyboard appears automatically in compatible text fields. Use the keyboard
button when an app does not open it automatically.

## Authentication

The phone starts locked. Press the power button to wake it, then enter your
Linux account password. In **Settings → Password & PIN**, choose a password
(at least 8 characters) or a PIN (6 to 12 digits), authenticate with your current
credentials, and enter the new value twice.

PIN setup derives a longer password and makes it your Linux account password;
it does not create a separate phone credential. Koya derives it again when you
enter the PIN to unlock or authorize a local account request. Terminal password
prompts and remote SSH clients do not perform this conversion. Use SSH keys for
remote access, or select password mode if you need to type the account password
outside Koya. Changing back to password mode sets a new account password.

If setup is interrupted, the input offers both methods so you can try the old
credentials or the new ones. Finish setup in Settings once unlocked.

Apps that request administrator access through polkit open Koya's password dialog in
the graphical session, including Power off and Restart when authorization is
required. SSH from a terminal or app launched by Koya uses the same dialog
when it needs a password or key passphrase. These remote credentials use literal
password entry; the phone PIN applies only to your local Linux account.
SSH key-use confirmations show **Allow** and **Cancel** instead of a password field. For a graphical `sudo`
prompt on systems with real sudo, use `sudo -A`. The default
postmarketOS `doas-sudo-shim` does not support that option; Koya's updater uses
polkit instead. Ordinary terminal privilege prompts still read from the
terminal. Incoming SSH logins authenticate on the remote client, so they do
not open a prompt on the phone.

## Updating Koya

Open **Update Koya** from the app launcher, save your work, then tap **Install
update**. Enter your administrator password or configured PIN in the Koya dialog. The app
shows the installed and repository commit hashes and how many commits the
installed shell is behind the configured ref. Older installations without a
recorded commit show an unknown installed revision until the next install.
The app shows download and build progress from the installer log. Koya closes
when the new session is selected, then starts again. Reopen the app to check
the new revision or view recent installer output. If the graphical session
does not return, connect over SSH and inspect
`/var/log/koya-shell/update.log`.

## Wi-Fi

Open **Wi-Fi** from the notification panel or app launcher.

1. Tap **Refresh** to scan for nearby networks.
2. Select a network. For a protected network, enter its password and tap
   **Connect**.
3. Use **Disconnect** to leave a connected network, or **Forget** to remove a
   saved network and its credentials.

Use **On/Off** to control the Wi-Fi radio. Saved networks reconnect using their
stored credentials.

The password form supports visible personal networks. Hidden-network entry and
enterprise credential setup are unavailable; existing enterprise profiles can
be used.

## Notifications

Tap the top bar or swipe down to see notifications. Use a notification's actions,
dismiss individual notifications, or clear the list.

Notifications do not wake the screen, and their contents are hidden on the swipe
screen. Notification history is cleared when the shell restarts.

## Settings

Open **Settings** from the app launcher. Choose **Wallpaper** for the four bundled
wallpapers; tap a preview to apply it to the home screen, lock screen and shell
panel backgrounds. The selected wallpaper is marked **Selected**.

**Screen & sleep** controls auto-rotation, screen timeouts and minimum brightness. **Volume &
vibration** controls touch feedback, volume buttons and the volume indicator.
Tap a setting to choose a value, or use its switch. All changes apply immediately
and are saved automatically; no session restart is needed.

Preferences are saved in `~/.config/koya-shell/settings.conf` (or under
`$XDG_CONFIG_HOME` when set). They override `current/session.conf` and survive
shell restarts and installation upgrades. The tables below show the base defaults.
Advanced options, including the audio output name, remain available in
`~/.local/share/koya-shell/current/session.conf`. If you installed with a custom
`--prefix`, use that directory's `current/session.conf` instead. Restart the
session after editing config files manually, and save your work first:

```sh
sudo rc-service tinydm restart
```

### Screen and sleep

Auto-rotate is on by default. Turn **Auto-rotate** off to keep the current screen
orientation. With it on, the display follows the phone's accelerometer after it
holds the same orientation for one second, including on the lock screen.
A brief fade covers the shell while it rearranges for the new screen size.
A device without an available sensor keeps its orientation.
The sensor is released while the display is off, the session is inactive, or
auto-rotate is off. The saved preference is `auto-rotate=true` in `[screen]`.

These settings are in the `[idle]` section. Values are seconds; `0` disables the
corresponding timeout.

| Setting | Default | Purpose |
| --- | --- | --- |
| `lock-seconds` | `120` | Show the lock screen and switch the display off after inactivity |
| `lock-screen-seconds` | `30` | Switch the display off while the lock screen is visible |
| `suspend-seconds` | `180` | Suspend after the display has switched off |

Automatic suspend depends on the phone's sleep support and session permissions.
Applications and SSH connections can inhibit sleep.

### Volume

These settings are in the `[volume]` section.

| Setting | Default | Purpose |
| --- | --- | --- |
| `buttons-enabled` | `true` | Enable the physical volume buttons |
| `indicator-enabled` | `true` | Show the volume indicator |
| `step-percent` | `5` | Volume change per button press |
| `maximum-percent` | `100` | Maximum output volume |
| `timeout-ms` | `1800` | Indicator duration in milliseconds |
| `side` | `left` | Indicator side: `left` or `right` |
| `margin` | `16` | Indicator distance from the edge |
| `position-percent` | `50` | Indicator position from top (`0`) to bottom (`100`) |
| `while-locked` | `true` | Allow volume buttons while the lock screen is visible or the display is off |
| `sink` | empty | Follow the default audio output; set a PulseAudio output name to choose one |

Changing volume while the display is off does not wake it. Volume up also unmutes
the output.

### Brightness and vibration

Use the slider in the notification panel to adjust brightness.

| Section | Setting | Default | Purpose |
| --- | --- | --- | --- |
| `[brightness]` | `minimum-percent` | `5` | Lowest slider brightness |
| `[haptics]` | `enabled` | `true` | Enable vibration feedback |
| `[haptics]` | `minimum-interval-ms` | `45` | Minimum interval between vibration effects |

### Display scaling

Hyprland settings are in `/etc/koya-shell/hyprland.conf`. The OnePlus 6 profile
uses display scale `2`. Restart the graphical session after changing this file.

For installation problems, missing vibration or incorrect battery readings, see
the [installation guide](installation.md#troubleshooting).

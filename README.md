# Koya Phone

A touch interface for Linux phones running [postmarketOS](https://postmarketos.org),
with an app launcher, desktops, notifications, Wi-Fi settings and an on-screen
keyboard, plus a Settings app for wallpapers and shell preferences. Built with
[Koya](https://www.koya-ui.com) and [Hyprland](https://hypr.land).

Koya Phone is experimental and designed for the OnePlus 6. It provides hardware
volume controls, brightness adjustment, vibration feedback, automatic screen
rotation and a power menu.
It does not include a calls or SMS interface.

**The swipe screen does not require a password and does not securely lock your
phone.**

## Screenshots

<p align="center">
  <a href="docs/screenshots/home.png"><img src="docs/screenshots/home.png" width="200" alt="Home screen"></a>
  <a href="docs/screenshots/apps.png"><img src="docs/screenshots/apps.png" width="200" alt="App launcher"></a>
  <a href="docs/screenshots/power-menu.png"><img src="docs/screenshots/power-menu.png" width="200" alt="Power menu"></a>
  <a href="docs/screenshots/terminal-keyboard.png"><img src="docs/screenshots/terminal-keyboard.png" width="200" alt="Terminal with the on-screen keyboard"></a>
</p>

## Install

Start with postmarketOS v25.12 or newer, with working device drivers, display,
audio and internet access. The installer requires compatible Hyprland 0.51.x
packages. Run as your graphical login user with `curl` and access to `sudo` or
`doas`:

```sh
curl -fsSL https://raw.githubusercontent.com/Omnomios/koya-phone/master/install.sh | sh
```

The installer installs Koya from its signed Alpine repo, builds the shell and
starts the new Koya/Hyprland session. **Save your work first: installation replaces
the current graphical session.** Firefox and Alacritty are included by default.

See the [installation guide](docs/installation.md) for options, troubleshooting
and the [OnePlus 6 battery fix](docs/installation.md#oneplus-6-battery-gauge-workaround).

## Develop on a desktop

Run the checkout in a nested Hyprland window on a Linux Wayland desktop:

```bash
./local-dev.sh
```

The container uses Alpine with pinned Hyprland and the latest Koya packages
from its signed repository.
It mounts the checkout for live UI edits and uses private services for phone
features. Press **F5** to restart after editing the UI. Podman or Docker, a
Wayland desktop and access to a GPU render device are required.

See the [local development guide](docs/local-development.md) for version
selection, controls and optional host setup with an installed Koya release.
The [repository layout](docs/repository-layout.md) separates shell code, phone
deployment and the development environment.

## Use

Tap **Apps** to launch an application, **Home** to return home, and **Desktops**
to switch or close applications. The keyboard button shows or hides the keyboard.

Open **Settings** from **Apps** to choose a wallpaper and adjust screen timeouts,
volume controls and vibration. Changes apply immediately and are saved.

Tap the top bar or swipe down for notifications, brightness and Wi-Fi settings.
Press the power button briefly to switch the screen off or wake it; hold it to
open the power menu. Swipe up to dismiss the swipe screen.

The [user guide](docs/user-guide.md) covers Wi-Fi, notifications, screen timeouts,
volume, brightness and vibration settings.

Licensed under the [MIT license](COPYING). Koya and other dependencies have their
own licenses.

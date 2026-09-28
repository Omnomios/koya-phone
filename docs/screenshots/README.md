# Screenshots

Captured from the running Koya Phone session on 28 September 2026:

- OnePlus 6, postmarketOS v25.12.
- Hyprland 0.51.1, display scale 2.
- Koya 0.5.3, build 888.
- PNG captures at 540×1140 logical pixels, without the pointer.

The images show Home, the installed app launcher, the power menu and a terminal
with Squeekboard open. They are compositor captures, not mockups.

To refresh a screenshot, stage the relevant UI and run this from the graphical
session with `grim` available:

```sh
grim -s 1 -l 9 docs/screenshots/home.png
```

The screenshot utility is a documentation tool, not a shell runtime dependency.

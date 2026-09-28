# Shell icons

Original SVG navigation and fallback app icons using the Koya fish colours:
warm cream #F4E9D8 and orange #D96A1D. PNG textures are generated without Python:

```sh
meson compile -C build
for source in assets/launcher/*.svg; do
    build/koya-render-icon "$source" "${source%.svg}.png"
done
```

Application icons come from their desktop entries. These bundled terminal and
touchpad icons are used when the selected theme and hicolor lack those names.

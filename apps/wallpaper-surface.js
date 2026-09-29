import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { WALLPAPERS, wallpaperFor, wallpaperFrame } from './wallpapers.js';

let selected = WALLPAPERS[0], serial = 0, queue = Promise.resolve();
const surfaces = new Set();
const frameIndex = wallpaper => WALLPAPERS.indexOf(wallpaper);

// Share the current artwork across home, swipe screen and dimmed sheet backdrops.
// Predefined frames let each texture retain its own crop without replacing UI nodes.
const artwork = (win, size, colour) => UI.createElement(win, {
  renderable: { type: 'sprite', texture: selected.texture, frame: frameIndex(selected),
    frames: WALLPAPERS.map(wallpaper => wallpaperFrame(wallpaper, size, colour)) },
  item: { size }, contentAlign: 'fill'
});

export async function wallpaperSurface(win, size, colour = [1, 1, 1, 1]) {
  // Keep the host (and its animation identity) while replacing cropped artwork
  // when the aspect ratio changes. Sprite frames are immutable in the UI API.
  const id = await UI.createElement(win, {
    renderable: { type: 'box', colour: [0, 0, 0, 0] },
    item: { size }, contentAlign: 'fill', inheritAnimation: true
  });
  const name = 'wallpaper-surface-' + ++serial;
  await UI.setElementId(win, id, name);
  const surface = { win, id, name, size: { ...size }, colour, sprite: await artwork(win, size, colour) };
  await UI.attach(win, id, surface.sprite);
  surfaces.add(surface);
  return id;
}

export function resizeWallpaper(win, id, size) {
  queue = queue.then(async () => {
    const surface = [...surfaces].find(value => value.win === win && value.id === id);
    if (!surface || surface.size.x === size.x && surface.size.y === size.y) return;
    const sprite = await artwork(win, size, surface.colour);
    await UI.attach(win, id, sprite);
    await UI.destroyElement(win, surface.sprite);
    await UI.setLayoutSize(win, id, size);
    surface.size = { ...size }; surface.sprite = sprite;
  });
  return queue;
}

export function configureWallpaper(state) {
  const next = wallpaperFor(state.Wallpaper);
  if (next === selected) return queue;
  selected = next;
  queue = queue.then(async () => {
    for (const surface of surfaces) {
      try {
        // Sheets can be destroyed while parked. Drop those bindings safely.
        if (await UI.getElementById(surface.win, surface.name) !== surface.id) { surfaces.delete(surface); continue; }
        await UI.setTexture(surface.win, surface.sprite, next.texture);
        await UI.setSpriteFrame(surface.win, surface.sprite, frameIndex(next));
      } catch (error) {
        surfaces.delete(surface);
        Log.error('Wallpaper surface: ' + error);
      }
    }
  });
  return queue;
}

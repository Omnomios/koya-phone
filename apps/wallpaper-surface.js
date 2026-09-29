import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { WALLPAPERS, wallpaperFor, wallpaperFrame } from './wallpapers.js';

let selected = WALLPAPERS[0], serial = 0, queue = Promise.resolve();
const surfaces = new Set();
const frameIndex = wallpaper => WALLPAPERS.indexOf(wallpaper);

// Share the current artwork across home, swipe screen and dimmed sheet backdrops.
// Predefined frames let each texture retain its own crop without replacing UI nodes.
export async function wallpaperSurface(win, size, colour = [1, 1, 1, 1]) {
  const initial = selected;
  const id = await UI.createElement(win, {
    renderable: { type: 'sprite', texture: initial.texture, frame: frameIndex(initial),
      frames: WALLPAPERS.map(wallpaper => wallpaperFrame(wallpaper, size, colour)) },
    item: { size }, contentAlign: 'fill'
  });
  const name = 'wallpaper-surface-' + ++serial;
  await UI.setElementId(win, id, name);
  surfaces.add({ win, id, name });
  if (initial !== selected) {
    await UI.setTexture(win, id, selected.texture);
    await UI.setSpriteFrame(win, id, frameIndex(selected));
  }
  return id;
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
        await UI.setTexture(surface.win, surface.id, next.texture);
        await UI.setSpriteFrame(surface.win, surface.id, frameIndex(next));
      } catch (error) {
        surfaces.delete(surface);
        Log.error('Wallpaper surface: ' + error);
      }
    }
  });
  return queue;
}

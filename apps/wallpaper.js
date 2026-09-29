import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import { connect } from './session.js';
import { wallpaperSurface } from './wallpaper-surface.js';

export default async () => {
  const displays = await Compositor.listDisplays();
  const win = await Compositor.createWindow({
    role: 'background', display: displays.length ? displays[0].display : '',
    exclusiveZone: -1, namespace: 'koya-background', msaaSamples: 1,
    keyboardInteractivity: 'none', acceptPointerEvents: false
  });
  const info = await Compositor.getWindowInfo(win);
  if (info.role !== 'background') throw new Error('Wallpaper requires layer-shell');
  const wallpaper = await wallpaperSurface(win, { x: info.width, y: info.height });
  await UI.attachRoot(win, wallpaper);
  connect('wallpaper');
};

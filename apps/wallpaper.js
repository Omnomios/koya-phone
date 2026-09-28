import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import { connect } from './session.js';

export default async () => {
  const displays = await Compositor.listDisplays();
  const win = await Compositor.createWindow({
    role: 'background', display: displays.length ? displays[0].display : '',
    exclusiveZone: -1, namespace: 'koya-background', msaaSamples: 1,
    keyboardInteractivity: 'none', acceptPointerEvents: false
  });
  const info = await Compositor.getWindowInfo(win);
  if (info.role !== 'background') throw new Error('Wallpaper requires layer-shell');
  const wallpaper = await UI.createElement(win, {
    renderable: {
      type: 'sprite', texture: '/rom/assets/earthy-green-wallpaper.png', frame: 0,
      frames: [{
        size: { x: info.width, y: info.height }, origin: { x: 0, y: 0 },
        aabb: { min: { x: 0, y: 0 }, max: { x: 864, y: 1821 } }, colour: [1, 1, 1, 1]
      }]
    },
    item: { size: { x: info.width, y: info.height } }, contentAlign: 'fill'
  });
  await UI.attachRoot(win, wallpaper);
  connect('wallpaper');
};

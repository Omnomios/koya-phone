import build from '../apps/navigation.js';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';
import * as Event from 'Helix/Event';
import { decodeDesktop, nextDesktop, appWindow, desktopCards } from '../apps/desktop-model.js';

export default async () => {
  const navigation = await build();
  const controller = navigation.drawers;
  if (Process.getEnv('KOYA_DESKTOP_TIMING', '0') === '1') return controller;
  setTimeout(async () => {
    try {
      const win = controller.window;
      if (!win) throw new Error('Desktop window was not created');
      const info = await Compositor.getWindowInfo(win);
      const grid = await UI.getElementById(win, 'desktop-view-grid');
      const frame = await UI.getElementFrame(win, grid);
      const root = await UI.getElementById(win, 'desktop-view-root');
      const model = decodeDesktop({ workspaces: '[{"id":1},{"id":2}]', clients: '[{"address":"0xabc","initialClass":"Example","workspace":{"id":2},"mapped":true},{"address":"0xdef","workspace":{"id":3},"mapped":true}]', activeworkspace: '{"id":2}' });
      if (nextDesktop(model) !== 4 || appWindow({ class: 'Example', id: 'example.desktop' }, model.clients)?.address !== '0xabc' || desktopCards(model).length !== 2
        || desktopCards({ ...model, active: { id: 1 } }).some(card => card.id === 1)) throw new Error('Desktop state projection failed');
      // Exercise an explicit UI change before capture, rather than depending on
      // a compositor that continuously repaints an unchanged window.
      await UI.setBoxColour(win, root, [0.065,0.13,0.105,1]);
      const mode = Process.getEnv('KOYA_DESKTOP_CAPTURE', 'apps');
      if (!await Screenshot.capture(win, { id: 'desktop', source: 'vulkan', mipmaps: false })) throw new Error('Capture unavailable');
      const png = await Image.encode(win, { src: '/ram/screenshot/desktop', format: 'png' });
      Process.writeFile('/tmp/koya-' + mode + '.png', png instanceof ArrayBuffer ? png : Uint8Array.from(png).buffer);
      let buttonFrame;
      if (mode === 'apps') {
        // Select an off-centre fixture tile when available and exaggerate scale
        // so a screen-origin pivot cannot hide behind subtle production motion.
        const pivotApp = Process.getEnv('KOYA_DESKTOP_PIVOT_APP', 'koya-wifi.desktop');
        const tile = await UI.getElementById(win, 'desktop-app-' + pivotApp);
        buttonFrame = await UI.getElementFrame(win, tile);
        await UI.setBoxColour(win, tile, [1, 0, 1, 1]);
        const scale = await UI.addAnimation(win, tile, [{ time: 0, scale: { x: 0.5, y: 0.5 } }]);
        await UI.setAnimationTime(win, tile, scale, 0);
        if (!await Screenshot.capture(win, { id: 'pivot', source: 'vulkan', mipmaps: false })) throw new Error('Pivot capture unavailable');
        const scaled = await Image.encode(win, { src: '/ram/screenshot/pivot', format: 'png' });
        Process.writeFile('/tmp/koya-button-pivot.png', scaled instanceof ArrayBuffer ? scaled : Uint8Array.from(scaled).buffer);
        if (JSON.stringify(buttonFrame) !== JSON.stringify(await UI.getElementFrame(win, tile))) throw new Error('Scale moved the touch layout');
      }
      Process.writeFileText('/tmp/koya-' + mode + '.json', JSON.stringify({ info, frame, buttonFrame }));
      setTimeout(() => {
        Process.writeFileText('/tmp/koya-desktop-action.json', JSON.stringify({ started: Date.now() }));
        Event.emit('keyDown', { id: win, key: 27 });
      }, 200);
    } catch (error) {
      Process.writeFileText('/tmp/koya-desktop-error.json', JSON.stringify({ error: String(error) }));
    }
  }, 1400);
};

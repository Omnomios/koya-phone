import build from '../apps/settings.js';
import { configureWallpaper, wallpaperSurface } from '../apps/wallpaper-surface.js';
import { WALLPAPERS } from '../apps/wallpapers.js';
import * as UI from 'Helix/UserInterface';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';
import * as Engine from 'Helix/Engine';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export default async () => {
  const win = await build();
  setTimeout(async () => {
    try {
      const app = globalThis.koyaSettings;
      for (let i = 0; i < 100 && !app.ready; i++) await pause(30);
      if (!app.ready) throw new Error('Settings did not connect');
      const capture = async name => {
        await app.settled(); await pause(250);
        if (!await Screenshot.capture(win, { id: name, source: 'vulkan', mipmaps: false })) throw new Error('Capture failed');
        const bytes = await Image.encode(win, { src: '/ram/screenshot/' + name, format: 'png' });
        Process.writeFile('/tmp/koya-settings-' + name + '.png', bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
      };
      await capture('home');
      await app.open('wallpaper'); await capture('wallpaper');
      for (const wallpaper of WALLPAPERS) {
        const frame = await UI.getElementFrame(win, await UI.getElementById(win, 'wallpaper-' + wallpaper.id));
        if (frame.min.x < 0 || frame.min.y < 0 || frame.max.y > 1000 || frame.size.x < 120) throw new Error('Invalid wallpaper card bounds: ' + JSON.stringify(frame));
      }
      await app.save('Wallpaper', 'violet-dusk'); await app.settled();
      if (app.state.Wallpaper !== 'violet-dusk') throw new Error('Wallpaper selection did not apply');
      await capture('selected');
      await app.open('screen'); await capture('screen');
      await app.open('sound'); await capture('sound');
      // A wallpaper surface retains its element/animation identity when changed.
      const sprite = await wallpaperSurface(win, { x: 100, y: 200 });
      await configureWallpaper({ Wallpaper: 'tidal-blue' });
      await configureWallpaper({ Wallpaper: 'earthy-green' });
      await UI.destroyElement(win, sprite);
      await configureWallpaper({ Wallpaper: 'violet-dusk' });
      Process.writeFileText('/tmp/koya-settings-capture.json', JSON.stringify({ passed: true }));
    } catch (error) {
      Process.writeFileText('/tmp/koya-settings-capture.json', JSON.stringify({ error: String(error), stack: error.stack }));
    } finally { Engine.quit(); }
  }, 800);
};

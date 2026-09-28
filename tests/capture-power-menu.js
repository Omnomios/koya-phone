import buildMenu from '../apps/power-menu.js';
import { buttonMotion } from '../apps/motion.js';
import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Event from 'Helix/Event';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export default async () => {
  const win = await buildMenu();
  const info = await Compositor.getWindowInfo(win);
  Process.writeFileText('/tmp/koya-test-menu.json', JSON.stringify(info));
  const capture = async (name, path) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await Screenshot.capture(win, { id: name, source: 'vulkan', mipmaps: false })) {
        const png = await Image.encode(win, { src: '/ram/screenshot/' + name, format: 'png' });
        Process.writeFile(path, png instanceof ArrayBuffer ? png : Uint8Array.from(png).buffer);
        return;
      }
      await delay(100);
    }
    throw new Error('Vulkan capture timed out');
  };
  setTimeout(async () => {
    try {
      const testMotion = Process.getEnv('KOYA_MOTION_TEST', '0') === '1';
      if (!testMotion) {
        await delay(500);
        await capture('menu', '/tmp/koya-power-menu.png');
        return;
      }
      await delay(65);
      await capture('enter', '/tmp/koya-power-menu-enter.png');
      await delay(450);
      await capture('menu', '/tmp/koya-power-menu.png');
      const moving = await UI.getElementById(win, 'power-menu-motion-2');
      const before = await UI.getElementFrame(win, moving);
      const motion = await buttonMotion(win, moving, before.size.x, 2);
      let releases = 0;
      await motion.onEnd('release', () => { releases++; });
      await motion.play('press');
      await delay(115);
      await capture('press', '/tmp/koya-power-menu-press.png');
      const pressedFrame = await UI.getElementFrame(win, moving);
      await motion.play('release');
      await delay(95);
      await capture('rebound', '/tmp/koya-power-menu-rebound.png');
      await delay(250);
      // Interrupt both directions before completion; they must settle and only
      // emit completion for the release that actually finishes.
      await motion.play('press');
      await delay(20);
      await motion.play('release');
      await delay(20);
      await motion.play('press');
      await delay(20);
      await motion.play('release');
      await delay(350);
      await capture('settled', '/tmp/koya-power-menu-settled.png');
      const after = await UI.getElementFrame(win, moving);
      if (JSON.stringify(before) !== JSON.stringify(pressedFrame) || JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Hit target moved during animation');
      if (releases !== 2) throw new Error('Unexpected animation completion count: ' + releases);
      Process.writeFileText('/tmp/koya-test-motion.json', JSON.stringify({ ok: true, releases, frame: after, events: Object.keys(Event) }));
      if (typeof Event.emit === 'function') {
        await delay(2200); // Let the harness sample idle CPU before dismissal.
        Process.writeFileText('/tmp/koya-test-exit.json', JSON.stringify({ started: Date.now() }));
        Event.emit('keyDown', { id: win, key: 27 });
      }
    } catch (error) {
      Process.writeFileText('/tmp/koya-test-motion.json', JSON.stringify({ ok: false, error: String(error) }));
    }
  }, 0);
};

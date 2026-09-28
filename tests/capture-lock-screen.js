import buildLock from '../apps/lock-screen.js';
import { lockMotion } from '../apps/lock-motion.js';
import { swipeGesture } from '../apps/swipe.js';
import * as UI from 'Helix/UserInterface';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';
import { call } from '../apps/session.js';

export default async () => {
  const win = await buildLock();
  setTimeout(async () => {
    try {
      const gesture = swipeGesture(1821);
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const down = { x: 400, y: 1200 };
      gesture.down(down); assert(!gesture.up(down), 'Tap unlocked');
      gesture.down(down); assert(!gesture.up({ x: 400, y: 1100 }), 'Short swipe unlocked');
      gesture.down(down); assert(!gesture.up({ x: 400, y: 1500 }), 'Downward swipe unlocked');
      gesture.down(down); assert(!gesture.up({ x: 800, y: 900 }), 'Horizontal swipe unlocked');
      gesture.down(down); gesture.cancel(); assert(!gesture.up({ x: 400, y: 800 }), 'Cancelled swipe unlocked');
      gesture.down(down); assert(gesture.move({ x: 400, y: 900 }) === 300, 'Drag feedback wrong');
      assert(gesture.up({ x: 400, y: 900 }), 'Upward swipe rejected');
      assert(!gesture.up({ x: 400, y: 900 }), 'Duplicate release unlocked');
      const sheet = await UI.getElementById(win, 'lock-sheet');
      const content = await UI.getElementById(win, 'lock-content');
      const before = await UI.getElementFrame(win, sheet);
      const textBefore = await UI.getElementFrame(win, content);
      const motion = await lockMotion(win, sheet, content, { x: 864, y: 1821 });
      const capture = async (id, path) => {
        if (!await Screenshot.capture(win, { id, source: 'vulkan', mipmaps: false })) throw new Error('Capture failed');
        const png = await Image.encode(win, { src: '/ram/screenshot/' + id, format: 'png' });
        Process.writeFile(path, png instanceof ArrayBuffer ? png : Uint8Array.from(png).buffer);
      };
      await capture('lock', '/tmp/koya-lock-screen.png');
      await motion.drag(180);
      await new Promise(resolve => setTimeout(resolve, 90));
      assert(JSON.stringify(before) === JSON.stringify(await UI.getElementFrame(win, sheet)), 'Zoom moved wallpaper layout');
      assert(JSON.stringify(textBefore) === JSON.stringify(await UI.getElementFrame(win, content)), 'Drag moved touch layout');
      await capture('lock-drag', '/tmp/koya-lock-drag.png');
      await motion.play('settle');
      await new Promise(resolve => setTimeout(resolve, 300));
      await capture('lock-settled', '/tmp/koya-lock-settled.png');
      Process.writeFileText('/tmp/koya-test-lock.json', JSON.stringify({ ok: true }));
      // Exercise the real owned-client unlock path after the host has checked DPMS.
      setTimeout(() => call('Unlock'), 3500);
    } catch (error) {
      Process.writeFileText('/tmp/koya-test-lock.json', JSON.stringify({ ok: false, error: String(error) }));
    }
  }, 1200);
};

import buildLock from '../apps/lock-screen.js';
import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';
import * as Engine from 'Helix/Engine';
import { call } from '../apps/session.js';

export default async () => {
  if (Process.getEnv('KOYA_TEST_PRIVATE_COMPOSITOR') !== '1')
    throw new Error('Run this capture only in a disposable private compositor');
  const win = await buildLock();
  setTimeout(async () => {
    try {
      const state = await call('GetState');
      if (!state.SecureLocked || await Compositor.sessionLockState() !== 'locked') throw new Error('Lock was not confirmed');
      if ((await Compositor.getWindowInfo(win)).role !== 'lock') throw new Error('Lock uses the wrong Wayland role');
      const field = await UI.getElementById(win, 'lock-credential');
      const frame = await UI.getElementFrame(win, field);
      if (frame.size.y < 48 || frame.min.y < 0) throw new Error('Credential field is not usable');
      if (!await Screenshot.capture(win, { id: 'lock', source: 'vulkan', mipmaps: false })) throw new Error('Capture failed');
      const png = await Image.encode(win, { src: '/ram/screenshot/lock', format: 'png' });
      Process.writeFile('/tmp/koya-lock-screen.png', png instanceof ArrayBuffer ? png : Uint8Array.from(png).buffer);
      Process.writeFileText('/tmp/koya-test-lock.json', JSON.stringify({ passed: true }));
    } catch (error) { Process.writeFileText('/tmp/koya-test-lock.json', JSON.stringify({ error: String(error), stack: error.stack })); }
    finally { Engine.quit(); }
  }, 2000);
  return win;
};

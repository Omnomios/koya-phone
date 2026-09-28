import build from '../apps/top-bar.js';
import { call } from '../apps/session.js';
import { haptic, configureHaptics } from '../apps/haptics.js';
import * as Bus from 'Module/dbus';
import * as UI from 'Helix/UserInterface';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = async () => Number(await Bus.call('org.sigxcpu.Feedback', '/org/sigxcpu/Feedback', 'org.sigxcpu.Feedback', 'Calls'));
export default async () => {
  await build({ volume: { command: '/home/user/koya-shell/tests/fixtures/pactl.sh' } });
  setTimeout(async () => {
    try {
      const notifications = globalThis.koyaNotifications, volume = globalThis.koyaVolume;
      const brightness = notifications.brightness;
      const idle = async controller => {
        for (let i = 0; i < 100 && controller.busy; i++) await pause(20);
        if (controller.busy) throw new Error('Device control did not finish');
        await pause(50);
      };
      await notifications.open(); await idle(brightness); await pause(300);
      if (!brightness.value.Available || brightness.value.Percent !== 50) throw new Error('Brightness read failed');
      brightness.setPercent(65); await idle(brightness);
      if (brightness.value.Percent !== 65 || (await call('GetBrightness')).Percent !== 65) throw new Error('Brightness write/readback failed');
      const win = notifications.centerWindow;
      const frame = await UI.getElementFrame(win, await UI.getElementById(win, 'brightness-slider'));
      if (frame.size.y !== 72 || frame.size.x < 200) throw new Error('Brightness touch target too small');
      const thumb = await UI.getElementFrame(win, await UI.getElementById(win, 'brightness-thumb'));
      if (thumb.size.x !== 28 || thumb.size.y !== 28) throw new Error('Brightness thumb has inherited the touch target size');
      if (thumb.centre.y !== frame.centre.y) throw new Error('Brightness thumb is not centred on the slider');
      if (!await Screenshot.capture(win, { id: 'controls', source: 'vulkan', mipmaps: false })) throw new Error('Capture unavailable');
      const bytes = await Image.encode(win, { src: '/ram/screenshot/controls', format: 'png' });
      Process.writeFile('/tmp/koya-device-controls.png', bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
      brightness.setPercent(0); await idle(brightness);
      if (brightness.value.Percent !== 5) throw new Error('Brightness floor failed');
      brightness.setPercent(70); brightness.setPercent(80); brightness.setPercent(90); await idle(brightness);
      if (brightness.value.Percent !== 90) throw new Error('Brightness coalesced writes lost the latest value');
      let calls = await count(); haptic(); haptic(); haptic(); await pause(100);
      if (await count() !== calls + 1) throw new Error('Haptic cue/rate limiting failed');
      const state = await call('GetState');
      configureHaptics({ ...state, HapticsEnabled: false });
      haptic(); await pause(60);
      if (await count() !== calls + 1) throw new Error('Disabled haptics still fired');
      configureHaptics(state); calls = await count();
      volume.onButton({ Button: 'volume-down', State: 'pressed' }); await idle(volume.audio); await pause(100);
      if (await count() !== calls + 1) throw new Error('Volume change did not trigger a haptic');
      await notifications.close();
      const before = (await call('GetBrightness')).Percent;
      brightness.setPercent(50); await idle(brightness);
      if ((await call('GetBrightness')).Percent !== before) throw new Error('Hidden brightness control changed the display');
      volume.audio.dispose();
      Process.writeFileText('/tmp/koya-device-controls.json', JSON.stringify({ frame, passed: true }));
    } catch (error) { globalThis.koyaVolume.audio.dispose(); Process.writeFileText('/tmp/koya-desktop-error.json', JSON.stringify({ error: String(error) })); }
  }, 700);
};

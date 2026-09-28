import build from '../apps/top-bar.js';
import { call } from '../apps/session.js';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';
import * as Bus from 'Module/dbus';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export default async () => {
  await build({ volume: { command: '/home/user/koya-shell/tests/fixtures/pactl.sh' } });
  setTimeout(async () => {
    const volume = globalThis.koyaVolume, audio = volume.audio;
    const events = [];
    Bus.onSignal(event => { if (event.member === 'HardwareButtonEvent') events.push(JSON.parse(event.body)); });
    const idle = async () => {
      for (let i = 0; i < 80 && audio.busy; i++) await pause(25);
      if (audio.busy) throw new Error('Audio command did not finish');
      await pause(60);
    };
    const button = (Button, State = 'pressed') => volume.onButton({ Button, State });
    try {
      await idle();
      if (!audio.snapshot.available || audio.snapshot.percent !== 65) throw new Error('Initial audio read failed: ' + JSON.stringify(audio.snapshot));
      for (const edge of [1, 2, 0]) await Bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1.Test', 'Button', 'uu', 114, edge);
      await idle(); await pause(400);
      if (audio.snapshot.percent !== 55) throw new Error('Press/repeat/release volume handling failed: ' + JSON.stringify({ snapshot: audio.snapshot, events }));
      const info = await Compositor.getWindowInfo(volume.window);
      const frame = await UI.getElementFrame(volume.window, await UI.getElementById(volume.window, 'volume-level'));
      if (!await Screenshot.capture(volume.window, { id: 'volume', source: 'vulkan', mipmaps: false })) throw new Error('Capture unavailable');
      const bytes = await Image.encode(volume.window, { src: '/ram/screenshot/volume', format: 'png' });
      Process.writeFile('/tmp/koya-volume.png', bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
      for (let i = 0; i < 20; i++) button('volume-up', 'repeat');
      await idle();
      if (audio.snapshot.percent !== 100 || Math.abs(audio.snapshot.channels[1] / audio.snapshot.channels[0] - 0.5) > 0.001) throw new Error('Cap or channel balance failed');
      await Process.exec('/home/user/koya-shell/tests/fixtures/pactl.sh set-sink-mute fixture-speaker 1');
      await pause(200); await idle();
      if (!audio.snapshot.muted) throw new Error('External mute subscription failed');
      button('volume-up'); await idle();
      if (audio.snapshot.muted || audio.snapshot.percent !== 100) throw new Error('Volume up did not unmute at ceiling');
      for (let i = 0; i < 22; i++) button('volume-down', 'repeat');
      await idle();
      if (audio.snapshot.percent !== 0) throw new Error('Volume floor failed');
      button('volume-up'); await idle();
      if (audio.snapshot.percent !== 5 || Math.abs(audio.snapshot.channels[1] / audio.snapshot.channels[0] - 0.5) > 0.001) throw new Error('Volume/balance up from silence failed');
      const state = await call('GetState');
      await volume.onState({ ...state, ScreenState: 'off' });
      button('volume-up'); await idle();
      if (volume.window || audio.snapshot.percent !== 10) throw new Error('Display-off buttons should adjust audio without showing UI');
      await volume.onState({ ...state, VolumeButtonsEnabled: false });
      button('volume-up'); await idle();
      if (audio.snapshot.percent !== 10) throw new Error('Disabled buttons still changed volume');
      audio.dispose();
      Process.writeFileText('/tmp/koya-volume.json', JSON.stringify({ info, frame, percent: audio.snapshot.percent, passed: true }));
    } catch (error) { audio.dispose(); Process.writeFileText('/tmp/koya-desktop-error.json', JSON.stringify({ error: String(error) })); }
  }, 600);
};

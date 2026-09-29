import buildSettings from '../apps/settings.js';
import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Engine from 'Helix/Engine';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';
import { session as Bus } from 'Module/dbus';
import { call } from '../apps/session.js';
import { BAR_HEIGHT, NAV_HEIGHT } from '../apps/theme.js';
import { WALLPAPERS } from '../apps/wallpapers.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const sensor = (method, signature = '', ...args) => Bus.call(
  'net.hadess.SensorProxy', '/net/hadess/SensorProxy', 'org.koya.Dev.Sensor', method, signature, ...args);
const output = async () => JSON.parse((await Process.exec('hyprctl -j monitors')).stdout)[0];
const wait = async (predicate, message) => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await pause(40); }
  throw new Error('Auto-rotation timed out: ' + message);
};
export default async () => {
  const win = await buildSettings();
  setTimeout(async () => {
    let before, initial;
    const checks = [];
    try {
      const app = globalThis.koyaSettings;
      await wait(() => app.ready, 'Settings did not connect'); before = await call('GetState');
      initial = await Bus.call('net.hadess.SensorProxy', '/net/hadess/SensorProxy',
        'org.freedesktop.DBus.Properties', 'GetAll', 's', 'net.hadess.SensorProxy');
      await call('SetSetting', 'ss', 'AutoRotateEnabled', 'true');
      await wait(async () => (await sensor('Counts')).ActiveClaims === 1, 'Sensor was not claimed');
      await app.open('wallpaper'); await app.settled();
      for (const [orientation, transform] of [['left-up', 1], ['bottom-up', 2], ['right-up', 3], ['normal', 0]]) {
        await sensor('SetOrientation', 's', orientation);
        await wait(async () => (await output()).transform === transform, 'Transform ' + transform);
        const monitor = await output();
        const layersDuring = JSON.parse((await Process.exec('hyprctl -j layers')).stdout);
        const shade = Object.values(layersDuring[monitor.name].levels).flat().find(layer => layer.namespace === 'koya-rotation-transition');
        const shadeWidth = (transform % 2 ? monitor.height : monitor.width) / monitor.scale;
        const shadeHeight = (transform % 2 ? monitor.width : monitor.height) / monitor.scale;
        assert(shade && shade.x === 0 && shade.y === 0 && shade.w === shadeWidth && shade.h === shadeHeight,
          'Rotation transition did not cover the output');
        if (!checks.length) {
          assert(await Screenshot.capture(win, { id: 'rotation-cover', source: 'wayland', display: monitor.name, cursor: false, mipmaps: false }), 'Transition capture failed');
          const bytes = await Image.encode(win, { src: '/ram/screenshot/rotation-cover', format: 'png' });
          Process.writeFile('/tmp/koya-rotation-cover.png', bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
        }
        await pause(250); await app.settled();
        const layersAfter = (await Process.exec('hyprctl -j layers')).stdout;
        assert(!layersAfter.includes('koya-rotation-transition'), 'Rotation transition remained on screen');
        const displays = await Compositor.listDisplays(), size = displays[0];
        const width = Number(size.logical_width), height = Number(size.logical_height);
        const info = await Compositor.getWindowInfo(win);
        assert(info.width === width && info.height === height - BAR_HEIGHT - NAV_HEIGHT, 'Sensor rotation left stale Settings geometry');
        for (const wallpaper of WALLPAPERS) {
          const frame = await UI.getElementFrame(win, await UI.getElementById(win, 'wallpaper-' + wallpaper.id));
          assert(frame.min.x >= 0 && frame.min.y >= 0 && frame.max.x <= info.width && frame.max.y <= info.height,
            'Wallpaper choice is outside its window after sensor rotation');
        }
        const state = await call('GetState');
        for (const name of ['wallpaper', 'top-bar', 'navigation']) assert(state[name + 'Pid'] === before[name + 'Pid'], 'Auto-rotation restarted ' + name);
        checks.push({ orientation, transform, width, height });
      }
      await app.open('screen'); await app.settled();
      const toggle = await UI.getElementById(win, 'setting-AutoRotateEnabled');
      assert(toggle > 0, 'Auto-rotate switch is missing');
      await pause(250);
      assert(await Screenshot.capture(win, { id: 'auto-rotate', source: 'vulkan', mipmaps: false }), 'Settings capture failed');
      const bytes = await Image.encode(win, { src: '/ram/screenshot/auto-rotate', format: 'png' });
      Process.writeFile('/tmp/koya-auto-rotate-settings.png', bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
      await app.save('AutoRotateEnabled', false); await app.settled();
      await wait(async () => !(await call('GetState')).AutoRotateEnabled, 'Preference was not disabled');
      await wait(async () => (await sensor('Counts')).ActiveClaims === 0, 'Sensor was not released');
      await sensor('SetOrientation', 's', 'left-up'); await pause(500);
      assert((await output()).transform === 0, 'Auto-rotate switch did not lock orientation');
      await app.save('AutoRotateEnabled', true); await app.settled();
      await wait(async () => (await output()).transform === 1, 'Auto-rotation did not re-enable');
      assert((await call('GetState')).AutoRotateEnabled, 'Auto-rotate switch did not enable orientation');
      Process.writeFileText('/tmp/koya-auto-rotation.json', JSON.stringify({ passed: true, checks, orientationLock: true }));
    } catch (error) {
      Process.writeFileText('/tmp/koya-auto-rotation.json', JSON.stringify({ passed: false, error: String(error), stack: error.stack, checks }));
    } finally {
      if (initial) await sensor('SetOrientation', 's', initial.AccelerometerOrientation);
      if (before) await call('SetSetting', 'ss', 'AutoRotateEnabled', String(before.AutoRotateEnabled));
      await pause(500); Engine.quit();
    }
  }, 500);
};

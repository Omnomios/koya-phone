import buildSettings from '../apps/settings.js';
import { call } from '../apps/session.js';
import { WALLPAPERS } from '../apps/wallpapers.js';
import { wallpaperSurface, resizeWallpaper } from '../apps/wallpaper-surface.js';
import { windowLayout } from '../apps/window-layout.js';
import { BAR_HEIGHT, NAV_HEIGHT } from '../apps/theme.js';
import * as Compositor from 'Koya/Compositor';
import * as Event from 'Helix/Event';
import * as UI from 'Helix/UserInterface';
import * as Process from 'Module/process';
import * as Engine from 'Helix/Engine';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const query = async topic => JSON.parse((await Process.exec('hyprctl -j ' + topic)).stdout);

// Run inside a private local-development session, using the updated Koya binary.
// Exercises real configure events, viewport resizing and application reflow.
export default async () => {
  const win = await buildSettings(), events = [];
  Event.on('windowResized', event => { if (event.id === win) events.push(event); });
  setTimeout(async () => {
  let initial, probe, autoRotate;
    const checks = [];
    try {
      initial = (await query('monitors'))[0];
      const app = globalThis.koyaSettings;
      for (let i = 0; i < 100 && !app.ready; i++) await pause(30);
      assert(app.ready, 'Settings did not connect');
      probe = await Compositor.createWindow({ role: 'overlay', anchor: 'top-left', display: initial.name,
        size: { x: 120, y: 180 }, namespace: 'koya-resize-probe', transparent: true,
        keyboardInteractivity: 'none', acceptPointerEvents: false });
      const probeEvents = [];
      Event.on('windowResized', event => { if (event.id === probe) probeEvents.push(event); });
      await Compositor.resizeWindow(probe, 180, 120); await pause(200);
      assert(probeEvents.length === 1 && probeEvents[0].width === 180 && probeEvents[0].height === 120,
        'Programmatic resize did not emit its configured logical size');
      await Compositor.destroyWindow(probe); probe = undefined;
      const before = await call('GetState');
      autoRotate = before.AutoRotateEnabled;
      await call('SetSetting', 'ss', 'AutoRotateEnabled', 'false');
      // Keep a real wallpaper layer in this process so WAYLAND_DEBUG records
      // viewport and buffer commits across every orientation.
      probe = await Compositor.createWindow({ role: 'background', display: initial.name,
        exclusiveZone: -1, namespace: 'koya-rotation-wallpaper-probe',
        keyboardInteractivity: 'none', acceptPointerEvents: false });
      const startSize = await Compositor.getWindowInfo(probe);
      const wall = await wallpaperSurface(probe, { x: startSize.width, y: startSize.height });
      await UI.attachRoot(probe, wall);
      windowLayout(probe, async size => {
        await Compositor.setWindowRenderingEnabled(probe, false);
        try { await resizeWallpaper(probe, wall, size); }
        finally { await Compositor.setWindowRenderingEnabled(probe, true); }
      });
      const components = ['wallpaper', 'top-bar', 'navigation'];
      for (const transform of [1, 2, 3, 4].map(step => (initial.transform + step) % 4)) {
        await app.open('wallpaper'); await app.settled();
        const count = events.length;
        const rule = initial.name + ',' + initial.width + 'x' + initial.height + '@' + initial.refreshRate + ',' + initial.x + 'x' + initial.y + ',' + initial.scale + ',transform,' + transform;
        await Process.exec('hyprctl keyword monitor ' + quote(rule));
        await pause(600); await app.settled();
        const output = (await Compositor.listDisplays()).find(value => value.display === initial.name);
        const width = Number(output.logical_width), height = Number(output.logical_height);
        const info = await Compositor.getWindowInfo(win);
        const wallpaperInfo = await Compositor.getWindowInfo(probe);
        assert(wallpaperInfo.width === width && wallpaperInfo.height === height, 'Wallpaper did not resize');
        assert(info.width === width && info.height === height - BAR_HEIGHT - NAV_HEIGHT, 'Settings did not resize');
        assert(events.length === count + 1, 'Expected one Settings resize event for a changed size');
        const event = events[events.length - 1];
        assert(event.width === info.width && event.height === info.height, 'Resize payload differs from the configured logical size');
        const layers = (await query('layers'))[initial.name].levels;
        const all = Object.values(layers).flat();
        for (const [namespace, h, y] of [['koya-background', height, 0], ['koya-top-bar', BAR_HEIGHT, 0],
          ['koya-navigation', NAV_HEIGHT, height - NAV_HEIGHT], ['koya-desktop-view', info.height, BAR_HEIGHT]]) {
          const layer = all.find(value => value.namespace === namespace);
          assert(layer?.w === width && layer.h === h && layer.y === y, 'Stale layer geometry: ' + namespace);
        }
        const cards = [];
        for (const wallpaper of WALLPAPERS) {
          const frame = await UI.getElementFrame(win, await UI.getElementById(win, 'wallpaper-' + wallpaper.id));
          assert(frame.min.x >= 0 && frame.min.y >= 0 && frame.max.x <= width && frame.max.y <= info.height,
            'Wallpaper choice is outside the resized window: ' + wallpaper.id);
          cards.push(frame);
        }
        assert(transform % 2 ? cards.every(frame => frame.min.y === cards[0].min.y) : cards[2].min.y > cards[0].min.y,
          'Wallpaper grid did not change orientation');
        await Process.exec('hyprctl keyword monitor ' + quote(rule));
        await pause(250);
        assert(events.length === count + 1, 'Unchanged configure emitted a duplicate resize');
        const after = await call('GetState');
        for (const name of components) assert(before[name + 'Pid'] === after[name + 'Pid'], 'Rotation restarted ' + name);
        checks.push({ transform, width, height, events: events.length, cards });
      }
      Process.writeFileText('/tmp/koya-rotation.json', JSON.stringify({ passed: true, checks }));
    } catch (error) {
      Process.writeFileText('/tmp/koya-rotation.json', JSON.stringify({ passed: false, error: String(error), stack: error.stack, events, checks }));
    } finally {
      if (probe !== undefined) await Compositor.destroyWindow(probe);
      if (initial) await Process.exec('hyprctl keyword monitor ' + quote(initial.name + ',' + initial.width + 'x' + initial.height + '@' + initial.refreshRate + ',' + initial.x + 'x' + initial.y + ',' + initial.scale + ',transform,' + initial.transform));
      if (autoRotate !== undefined) await call('SetSetting', 'ss', 'AutoRotateEnabled', String(autoRotate));
      Engine.quit();
    }
  }, 500);
};

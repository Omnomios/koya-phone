import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as PAM from 'Module/pam';
import * as Log from 'Helix/Log';
import * as Engine from 'Helix/Engine';
import { connect, call } from './session.js';
import { windowLayout } from './window-layout.js';
import { wallpaperSurface } from './wallpaper-surface.js';
import { unlockPanel } from './unlock-panel.js';
import { credentialMode } from './credential-model.js';
import { lockController } from './lock-controller.js';
import { lockMotion } from './lock-motion.js';
import { swipeGesture } from './swipe.js';
import { clips } from './motion.js';
import * as Event from 'Helix/Event';
import { button, text, label } from './touch-ui.js';
import { CREAM, ORANGE, MUTED, INK, CARD, GUTTER, SPACE, TYPE } from './theme.js';

export default async () => {
  let state = {}, confirming = false, ending = false, rendering = Promise.resolve();
  const serialize = job => {
    const next = rendering.then(job);
    rendering = next.catch(() => {});
    return next;
  };
  const screens = new Map();
  let message = '';
  const status = value => { message = value; for (const screen of screens.values()) if (screen.status) UI.setTextString(screen.win, screen.status, value).catch(() => {}); };
  const available = () => !!state.Active && state.ScreenState === 'locked' && state.SecureLocked && !ending;
  const controller = lockController({
    authenticate: (password, user) => PAM.authenticate({ service: 'koya-lock', user, password }),
    unlock: async generation => {
      // Recheck coordinator policy after PAM, before releasing the Wayland lock.
      const current = await call('GetState');
      if (!current.Active || current.ScreenState !== 'locked' || current.LockGeneration !== generation) throw new Error('Unlock cancelled');
      await call('BeginUnlock', 'u', generation);
      try { await Compositor.unlockSession(); }
      catch (error) { await call('CancelUnlock', 'u', generation); throw error; }
      ending = !!await call('Unlock', 'u', generation);
    },
    onStatus: status
  });
  const submit = async screen => {
    if (!screen.input?.enabled || screen.submitting || controller.busy || ending) return;
    screen.submitting = true;
    try {
      const input = screen.input;
      const checking = controller.submit(() => input.answer());
      input.clear();
      for (const item of screens.values()) await item.input?.setEnabled(false);
      // A refused answer shakes the field it came from.
      if (!await checking && !ending) input.reject?.();
    } catch (_) { status('Enter your password or a PIN of 4 to 12 digits'); }
    finally { screen.submitting = false; if (!ending) for (const item of screens.values()) await item.input?.setEnabled(item.authenticating && available()); }
  };
  const format = () => {
    const now = new Date();
    return [String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
      ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()] + ', ' + now.getDate() + ' ' +
      ['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()]];
  };
  const cover = async screen => {
    const { win, size } = screen;
    const content = await UI.createElement(win, {
      layout: { type: 'column', padding: { l: 0, r: 0, t: Math.round(size.y * 0.16), b: Math.max(40, Math.round(size.y * 0.05)) } }, item: { size }
    });
    await UI.attach(win, screen.root, content);
    await UI.setInheritAnimation(win, content, true);
    await UI.setElementId(win, content, 'lock-content');
    const now = format(), clockSize = Math.min(TYPE.display, size.x * 0.2);
    screen.clock = await text(win, content, now[0], clockSize, 'auto', clockSize * 1.2);
    screen.date = await text(win, content, now[1], Math.min(TYPE.heading, size.x * 0.05), 'auto', 32);
    await UI.attach(win, content, await UI.createElement(win, { item: { flexGrow: 1 } }));
    const arrow = await text(win, content, '↑', 30, 'auto', 40, ORANGE);
    await text(win, content, 'Swipe up to unlock', TYPE.caption + 1, 'auto', 28, MUTED);
    const nudge = await clips(win, arrow, { hint: [
      { time: 0.2, position: { x: 0, y: 0 } },
      { time: 0.34, position: { x: 0, y: -SPACE.s }, ease: 'outQuad' },
      { time: 0.52, position: { x: 0, y: 0 }, ease: 'inOutQuad' },
      { time: 0.66, position: { x: 0, y: -SPACE.s }, ease: 'outQuad' },
      { time: 0.84, position: { x: 0, y: 0 }, ease: 'inOutQuad' }
    ] });
    const motion = await lockMotion(win, screen.wall, content, size);
    const gesture = screen.gesture = swipeGesture(size.y), epoch = screen.epoch;
    const live = () => screen.epoch === epoch && !screen.authenticating && !screen.transitioning && available();
    const hint = () => nudge.play('hint').catch(() => {});
    let distance = null, queued = false;
    const settle = () => {
      gesture.cancel(); distance = null;
      if (live()) serialize(() => screen.epoch === epoch && motion.play('settle'));
    };
    const target = await UI.createElement(win, {
      item: { size },
      onMouseDown: point => { if (live()) gesture.down({ x: point.x, y: point.y }); },
      onMouseMove: point => {
        if (!live()) return;
        distance = gesture.move(point);
        if (distance === null || queued) return;
        queued = true;
        serialize(async () => {
          try {
            while (distance !== null && live()) { const latest = distance; distance = null; await motion.drag(latest); }
          } finally { queued = false; }
        });
      },
      onMouseUp: point => {
        if (!live()) return;
        const travel = gesture.move(point);
        if (!gesture.up(point)) { settle(); hint(); return; }
        screen.transitioning = true; distance = null;
        serialize(async () => {
          if (screen.epoch !== epoch || !available()) return;
          await motion.leave(travel);
          await new Promise(resolve => setTimeout(resolve, 250));
          if (screen.epoch !== epoch || !available()) return;
          screen.authenticating = true;
          await build(screen);
        }).catch(() => {});
      },
      onMouseExit: settle
    });
    await UI.attach(win, screen.root, target);
    await UI.setElementId(win, target, 'lock-swipe');
    await motion.play('enter'); hint();
  };
  const dismiss = () => {
    controller.cancel(); message = '';
    for (const screen of screens.values()) {
      screen.input?.dispose(); screen.authenticating = false; screen.transitioning = false; screen.needsBuild = true; ++screen.epoch;
    }
    serialize(async () => { for (const screen of screens.values()) await build(screen); }).catch(() => {});
  };
  Event.on('keyDown', event => {
    const screen = [...screens.values()].find(item => item.win === event.id);
    if (screen?.authenticating && [1, 65307].includes(event.key)) dismiss(screen);
  });
  const build = async screen => {
    const { win, size } = screen;
    const profile = [state.AuthenticationMode, state.AuthenticationSalt, state.PendingAuthenticationMode, state.PendingAuthenticationSalt].join(':');
    const sameProfile = profile === screen.profile;
    const old = sameProfile ? screen.input?.value || '' : '';
    const mode = sameProfile && screen.input?.mode || credentialMode(state, state.UserName);
    screen.profile = profile;
    screen.input?.dispose();
    screen.input = screen.status = undefined;
    screen.gesture?.cancel(); const epoch = ++screen.epoch; screen.transitioning = false;
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
      if (screen.root) await UI.destroyElement(win, screen.root);
      screen.root = await UI.createElement(win, { renderable: { type: 'box', colour: INK }, item: { size }, contentAlign: 'fill' });
      await UI.attachRoot(win, screen.root);
      const power = state.PowerMenuState === 'open' || state.PowerMenuState === 'pending';
      screen.wall = await wallpaperSurface(win, size, screen.authenticating || power ? [0.32, 0.38, 0.34, 1] : [0.45, 0.50, 0.43, 1]);
      await UI.attach(win, screen.root, screen.wall);
      await UI.setElementId(win, screen.wall, 'lock-sheet');
      if (!screen.authenticating && !power) { await cover(screen); return; }
      if (!power) {
        const panel = await unlockPanel(win, screen.root, size, { user: state.UserName, profile: state, mode, value: old, time: format(),
          message, onSubmit: () => submit(screen), onCancel: () => dismiss(screen) });
        screen.input = panel.input; screen.status = panel.status; screen.clock = panel.clock; screen.date = panel.date;
        await screen.input.setEnabled(screen.authenticating && available());
        return;
      }
      const landscape = size.x > size.y;
      const inset = landscape ? GUTTER : Math.max(GUTTER, Math.round((size.x - 480) / 2));
      const width = size.x - 2 * inset;
      const body = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s,
        padding: { l: inset, r: inset, t: landscape ? 12 : Math.round(size.y * 0.08), b: GUTTER } }, item: { size } });
      await UI.attach(win, screen.root, body);
      const now = format();
      screen.clock = await text(win, body, now[0], landscape ? 44 : 80, width, landscape ? 52 : 96);
      screen.date = await text(win, body, now[1], TYPE.caption + 1, width, 28, MUTED);
      if (!landscape) await UI.attach(win, body, await UI.createElement(win, { item: { size: { x: width, y: 24 }, flexGrow: 1 } }));
      // Power menu while locked: the panel's actions, without credentials.
      await text(win, body, 'Power', TYPE.heading, width, 30, CREAM);
      screen.input = undefined;
      for (const [title, method] of [['Power off', 'PowerOff'], ['Restart', 'Reboot'], ['Cancel', 'DismissPowerMenu']])
        await button(win, body, title, width, 56, () => call(method).catch(() => status('Action unavailable')), { colour: CARD });
      screen.status = await label(win, body, message, TYPE.caption, width, 28, ORANGE);
      if (!landscape) await UI.attach(win, body, await UI.createElement(win, { item: { size: { x: width, y: 12 }, flexGrow: 1 } }));
    } finally {
      screen.needsBuild = screen.epoch !== epoch;
      await Compositor.setWindowRenderingEnabled(win, true);
    }
  };
  const add = async display => {
    const win = await Compositor.createWindow({ role: 'lock', display: display.display, msaaSamples: 1, transparent: false, acceptPointerEvents: true });
    const info = await Compositor.getWindowInfo(win);
    if (info.role !== 'lock') throw new Error('Compositor did not create a session lock surface');
    await Compositor.setClearColor(win, ...INK);
    const screen = { win, display: display.display, size: { x: info.width, y: info.height }, authenticating: false, epoch: 0 };
    screens.set(display.display, screen); await build(screen);
    windowLayout(win, next => serialize(async () => {
      if (screens.get(screen.display) !== screen) return;
      Object.assign(screen.size, next); await build(screen);
    }));
    return screen;
  };
  const displays = await Compositor.listDisplays();
  if (!displays.length) throw new Error('No lock display available');
  for (const display of displays) await add(display);
  const confirmed = async () => {
    for (let attempt = 0; attempt < 100; ++attempt) {
      const value = await Compositor.sessionLockState();
      if (value === 'locked') return;
      if (value === 'finished' || value === 'unlocked') throw new Error('The compositor refused to lock');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The compositor did not confirm the lock');
  };
  let previous;
  connect('lock-screen', next => {
    controller.update(next);
    const reset = !next.Active || next.ScreenState !== 'locked' || next.LockGeneration !== state.LockGeneration || next.PowerMenuState !== state.PowerMenuState;
    const rebuild = reset || next.AuthenticationMode !== state.AuthenticationMode || next.AuthenticationSalt !== state.AuthenticationSalt || next.PendingAuthenticationSalt !== state.PendingAuthenticationSalt;
    state = next;
    if (rebuild) for (const screen of screens.values()) screen.needsBuild = true;
    if (reset && next.ScreenState !== 'unlocked') {
      controller.cancel(); message = '';
      for (const screen of screens.values()) { screen.input?.dispose(); screen.gesture?.cancel(); screen.authenticating = false; screen.transitioning = false; ++screen.epoch; }
    }
    return serialize(async () => {
      if (state !== next) return;
      if (state.ScreenState === 'unlocked') return;
      if (previous !== state.LockGeneration) ending = false;
      if (previous !== state.LockGeneration && previous !== undefined && await Compositor.sessionLockState() === 'unlocked') {
        for (const screen of screens.values()) { screen.input?.dispose(); await Compositor.destroyWindow(screen.win); }
        screens.clear();
        for (const display of await Compositor.listDisplays()) await add(display);
        await confirmed(); await call('Ready', 's', 'lock-screen');
      }
      previous = state.LockGeneration;
      for (const screen of screens.values()) {
        if (screen.needsBuild) await build(screen);
        if (state.ScreenState !== 'locked' || !state.Active) screen.input?.clear();
        await screen.input?.setEnabled(screen.authenticating && available());
      }
    });
  }, undefined, undefined, confirmed);
  setInterval(async () => {
    if (ending || confirming) return;
    confirming = true;
    try {
      if (await Compositor.sessionLockState() === 'finished') { controller.cancel(); Engine.quit(); return; }
      await serialize(async () => {
        const displays = await Compositor.listDisplays(), available = new Set(displays.map(display => display.display));
        for (const [id, screen] of screens) if (!available.has(id)) {
          screen.input?.dispose(); await Compositor.destroyWindow(screen.win); screens.delete(id);
        }
        for (const display of displays) if (!screens.has(display.display)) await add(display);
        const now = format();
        for (const screen of screens.values()) {
          // The landscape unlock panel shows the time without a date.
          if (screen.clock) await UI.setTextString(screen.win, screen.clock, now[0]);
          if (screen.date) await UI.setTextString(screen.win, screen.date, now[1]);
        }
      });
    } catch (_) { Log.error('Lock display could not update'); }
    finally { confirming = false; }
  }, 1000);
  return screens.values().next().value.win;
};

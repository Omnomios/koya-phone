import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as PAM from 'Module/pam';
import * as Log from 'Helix/Log';
import * as Engine from 'Helix/Engine';
import { connect, call } from './session.js';
import { windowLayout } from './window-layout.js';
import { wallpaperSurface } from './wallpaper-surface.js';
import { credentialInput } from './credential-input.js';
import { credentialMode } from './credential-model.js';
import { lockController } from './lock-controller.js';
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
  const status = value => { for (const screen of screens.values()) UI.setTextString(screen.win, screen.status, value).catch(() => {}); };
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
      await checking;
    } catch (_) { status('Enter your password or a PIN of 6 to 12 digits'); }
    finally { screen.submitting = false; if (!ending) for (const item of screens.values()) await item.input?.setEnabled(state.Active && state.ScreenState === 'locked' && state.SecureLocked); }
  };
  const format = () => {
    const now = new Date();
    return [String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
      ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()] + ', ' + now.getDate() + ' ' +
      ['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()]];
  };
  const build = async screen => {
    const { win, size } = screen;
    const profile = [state.AuthenticationMode, state.AuthenticationSalt, state.PendingAuthenticationMode, state.PendingAuthenticationSalt].join(':');
    const sameProfile = profile === screen.profile;
    const old = sameProfile ? screen.input?.value || '' : '';
    const mode = sameProfile && screen.input?.mode || credentialMode(state, state.UserName);
    screen.profile = profile;
    screen.input?.dispose();
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
      if (screen.root) await UI.destroyElement(win, screen.root);
      screen.root = await UI.createElement(win, { renderable: { type: 'box', colour: INK }, item: { size }, contentAlign: 'fill' });
      await UI.attachRoot(win, screen.root);
      screen.wall = await wallpaperSurface(win, size, [0.32, 0.38, 0.34, 1]);
      await UI.attach(win, screen.root, screen.wall);
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
      const title = state.PowerMenuState === 'open' || state.PowerMenuState === 'pending' ? 'Power' : state.UserName || 'Unlock';
      await text(win, body, title, TYPE.heading, width, 30, CREAM);
      if (state.PowerMenuState === 'open' || state.PowerMenuState === 'pending') {
        screen.input = undefined;
        for (const [title, method] of [['Power off', 'PowerOff'], ['Restart', 'Reboot'], ['Cancel', 'DismissPowerMenu']])
          await button(win, body, title, width, 56, () => call(method).catch(() => status('Action unavailable')), { colour: CARD });
      } else {
        screen.input = await credentialInput(win, body, { width, value: old, profile: state,
          mode, compact: landscape, rowHeight: landscape ? 32 : 52,
          id: 'lock-credential', onSubmit: () => submit(screen) });
        await screen.input.setEnabled(!!state.Active && state.ScreenState === 'locked' && state.SecureLocked);
      }
      screen.status = await label(win, body, '', TYPE.caption, width, 28, ORANGE);
      if (screen.input) await button(win, body, 'Unlock', width, 48, () => submit(screen), { colour: ORANGE });
      if (!landscape) await UI.attach(win, body, await UI.createElement(win, { item: { size: { x: width, y: 12 }, flexGrow: 1 } }));
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
  };
  const add = async display => {
    const win = await Compositor.createWindow({ role: 'lock', display: display.display, msaaSamples: 1, transparent: false, acceptPointerEvents: true });
    const info = await Compositor.getWindowInfo(win);
    if (info.role !== 'lock') throw new Error('Compositor did not create a session lock surface');
    await Compositor.setClearColor(win, ...INK);
    const screen = { win, display: display.display, size: { x: info.width, y: info.height } };
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
  connect('lock-screen', next => serialize(async () => {
    controller.update(next);
    const rebuild = next.PowerMenuState !== state.PowerMenuState || next.AuthenticationMode !== state.AuthenticationMode || next.AuthenticationSalt !== state.AuthenticationSalt || next.PendingAuthenticationSalt !== state.PendingAuthenticationSalt;
    state = next;
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
      if (rebuild) await build(screen);
      if (state.ScreenState !== 'locked' || !state.Active) screen.input?.clear();
      await screen.input?.setEnabled(!!state.Active && state.ScreenState === 'locked' && state.SecureLocked);
    }
  }), undefined, undefined, confirmed);
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
        for (const screen of screens.values()) { await UI.setTextString(screen.win, screen.clock, now[0]); await UI.setTextString(screen.win, screen.date, now[1]); }
      });
    } catch (_) { Log.error('Lock display could not update'); }
    finally { confirming = false; }
  }, 1000);
  return screens.values().next().value.win;
};

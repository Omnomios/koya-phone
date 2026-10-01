import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Event from 'Helix/Event';
import * as Engine from 'Helix/Engine';
import * as Log from 'Helix/Log';
import { session as Bus } from 'Module/dbus';
import { credentialInput, credentialKeyboardHeight } from './credential-input.js';
import { credentialMode } from './credential-model.js';
import { button, label, text } from './touch-ui.js';
import { CREAM, ORANGE, INK, CARD, MUTED, CLEAR, GUTTER, SPACE, RADIUS, TYPE, TOUCH } from './theme.js';

const NAME = 'org.koya.Shell1', PATH = '/org/koya/Shell1';
const call = (method, signature = '', ...args) => Bus.call(NAME, PATH, NAME, method, signature, ...args);
const clean = text => String(text || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512);
export default async () => {
  let win, root, input, statusLabel, active, size, profile = {}, waiting = false, sending = false;
  let queue = Promise.resolve();
  const enqueue = job => { queue = queue.then(job).catch(() => Log.error('Authentication dialog could not update')); return queue; };
  const hide = async () => {
    input?.dispose(); input = undefined; waiting = sending = false; active = undefined;
    if (win) await Compositor.destroyWindow(win);
    win = root = undefined;
  };
  const cancel = () => active && call('AuthenticationCancel', 'u', active.id).catch(() => {});
  const submit = async () => {
    if (!active || !waiting || sending) return;
    const request = active;
    sending = true;
    try {
      const answer = request.noInput ? '' : await input.answer();
      if (active !== request) return;
      input?.clear(); await input?.setEnabled(false); waiting = false;
      await UI.setTextString(win, statusLabel, 'Checking…');
      await call('AuthenticationRespond', 'us', request.id, answer);
    } catch (_) {
      if (active === request && win) {
        waiting = true; await input?.setEnabled(true); input?.focus(); input?.reject();
        await UI.setTextString(win, statusLabel, 'Check your password or PIN and try again');
      }
    } finally { if (active === request) sending = false; }
  };
  const build = async (echo = false) => {
    if (!win || !active) return;
    const value = input?.value || ''; const mode = input?.mode;
    input?.dispose(); input = undefined;
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
      if (root) await UI.destroyElement(win, root);
      // Same structure as the lock screen: the keyboard docks to the bottom
      // edge, the request and its field sit directly above it, Cancel sits
      // where back always sits, and Enter carries the action.
      const landscape = size.x > size.y;
      const keyboard = active.noInput ? 0 : credentialKeyboardHeight(size);
      const width = Math.min(landscape ? 520 : 420, size.x - 2 * GUTTER);
      const full = size.x - 2 * GUTTER;
      root = await UI.createElement(win, { renderable: { type: 'box', colour: [0.025, 0.055, 0.04, 0.97] }, item: { size }, contentAlign: 'fill' });
      await UI.attachRoot(win, root);
      const body = await UI.createElement(win, { layout: { type: 'column', alignItems: 'center', padding: { l: GUTTER, r: GUTTER, t: SPACE.s, b: SPACE.m } },
        item: { position: { x: 0, y: 0 }, size: { x: size.x, y: size.y - keyboard } } });
      await UI.attach(win, root, body);
      const top = await UI.createElement(win, { layout: { type: 'row', alignItems: 'center' }, item: { size: { x: full, y: TOUCH } } });
      await UI.attach(win, body, top);
      if (active.mode !== 'none') await button(win, top, 'Cancel', 96, TOUCH, cancel, { colour: CLEAR, labelColour: MUTED, size: TYPE.body, radius: RADIUS.control });
      await UI.attach(win, body, await UI.createElement(win, { item: { size: { x: full, y: 0 }, flexGrow: 1 } }));
      // What is asking, and as whom.
      await text(win, body, 'Authentication required', TYPE.heading, width, 32, CREAM, undefined, 'left');
      await label(win, body, active.message, TYPE.body, width, landscape ? 30 : 52, MUTED);
      await label(win, body, active.user ? 'As ' + active.user : '', TYPE.caption, width, 24, MUTED);
      if (active.question) await label(win, body, active.question, TYPE.caption, width, 24, MUTED);
      await UI.attach(win, body, await UI.createElement(win, { item: { size: { x: full, y: SPACE.m } } }));
      if (!active.noInput) {
        const literal = echo || active.action.startsWith('org.koya.Askpass.') || active.user !== profile.UserName;
        input = await credentialInput(win, body, { width, value, mode: literal ? 'password' : mode || credentialMode(profile, active.user),
          profile: literal ? {} : profile, echo, placeholder: echo ? 'Enter response' : 'Enter password',
          enterLabel: 'Confirm', dock: { parent: root, size }, onSubmit: () => enqueue(submit), onCancel: cancel });
        await input.setEnabled(waiting && !sending); if (waiting) input.focus();
      }
      statusLabel = await text(win, body, active.status || '', TYPE.caption, width, 28, ORANGE);
      if (active.noInput) {
        // Confirmation only: two clear choices instead of a keyboard.
        const actions = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.s }, item: { size: { x: width, y: 56 } } });
        await UI.attach(win, body, actions);
        const actionWidth = active.mode === 'none' ? width : (width - SPACE.s) / 2;
        if (active.mode !== 'none') await button(win, actions, 'Deny', actionWidth, 56, cancel, { colour: CARD, size: TYPE.body });
        await button(win, actions, active.mode === 'confirm' ? 'Allow' : 'Close', actionWidth, 56, () => enqueue(submit),
          { colour: ORANGE, labelColour: INK, size: TYPE.body });
      }
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
  };
  const begin = async (id, action, message, user) => {
    await hide(); profile = await call('GetState');
    if (!profile.Active || profile.ScreenState !== 'unlocked') { await call('AuthenticationCancel', 'u', id); return; }
    const mode = action.startsWith('org.koya.Askpass.') ? action.slice('org.koya.Askpass.'.length) : 'entry';
    active = { id, action, mode, noInput: mode === 'confirm' || mode === 'none', message: clean(message) || 'Administrator access is required', user: clean(user), question: '', status: '' };
    const display = (await Compositor.listDisplays())[0];
    if (!display) { cancel(); return; }
    win = await Compositor.createWindow({ role: 'overlay', anchor: 'fill', display: display.display,
      size: { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) },
      namespace: 'koya-authentication', exclusiveZone: -1, msaaSamples: 1, transparent: true,
      keyboardInteractivity: 'exclusive', acceptPointerEvents: true });
    const info = await Compositor.getWindowInfo(win); size = { x: info.width, y: info.height };
    await Compositor.setClearColor(win, 0, 0, 0, 0); await build();
  };
  Event.on('windowResized', event => { if (event.id === win) enqueue(async () => { size = { x: event.width, y: event.height }; await build(active?.echo); }); });
  Event.on('keyDown', event => { if (event.id === win && [1, 65307].includes(event.key)) cancel(); });
  setTimeout(async () => {
    try {
      await Bus.connect();
      Bus.onSignal(event => {
        if (event.interface === NAME) {
          const [id, first, second, third] = event.args || [];
          if (event.member === 'AuthenticationBegin') enqueue(() => begin(id, first, second, third));
          if (event.member === 'AuthenticationPrompt') enqueue(async () => {
            if (active?.id !== id) return;
            active.question = clean(first); active.echo = !!second; waiting = true; sending = false;
            input?.clear(); await build(active.echo);
          });
          if (event.member === 'AuthenticationMessage') enqueue(async () => {
            if (active?.id !== id || !win) return;
            active.status = clean(first); await UI.setTextString(win, statusLabel, active.status);
          });
          if (event.member === 'AuthenticationEnd') enqueue(() => active?.id === id ? hide() : undefined);
          if (event.member === 'StateChanged' && active && (id.ScreenState !== 'unlocked' || !id.Active)) enqueue(async () => { cancel(); await hide(); });
        }
        if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged' && event.args?.[0] === NAME && !event.args[2]) Engine.quit();
      });
      for (const member of ['AuthenticationBegin', 'AuthenticationPrompt', 'AuthenticationMessage', 'AuthenticationEnd', 'StateChanged'])
        await Bus.addMatch(`type='signal',sender='${NAME}',interface='${NAME}',member='${member}'`);
      await Bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.koya.Shell1'");
      await call('Ready', 's', 'authentication');
    } catch (_) { Log.error('Authentication setup failed'); Engine.quit(); }
  }, 0);
};

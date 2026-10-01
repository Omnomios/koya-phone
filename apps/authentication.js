import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Event from 'Helix/Event';
import * as Engine from 'Helix/Engine';
import * as Log from 'Helix/Log';
import { session as Bus } from 'Module/dbus';
import { credentialInput } from './credential-input.js';
import { credentialMode } from './credential-model.js';
import { button, label, text } from './touch-ui.js';
import { CREAM, ORANGE, INK, CARD, MUTED, GUTTER, SPACE, TYPE } from './theme.js';

const NAME = 'org.koya.Shell1', PATH = '/org/koya/Shell1';
const call = (method, signature = '', ...args) => Bus.call(NAME, PATH, NAME, method, signature, ...args);
const clean = text => String(text || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512);
export default async () => {
  let win, root, input, statusLabel, submitLabel, active, size, profile = {}, waiting = false, sending = false;
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
        waiting = true; await input?.setEnabled(true); input?.focus();
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
      const landscape = size.x > size.y;
      const width = Math.min(landscape ? 1100 : 520, size.x - 2 * GUTTER), side = Math.round((size.x - width) / 2);
      root = await UI.createElement(win, { renderable: { type: 'box', colour: [0.025, 0.055, 0.04, 0.97] },
        layout: { type: 'column', gap: SPACE.s, padding: { l: side, r: side, t: landscape ? 8 : Math.round(size.y * 0.10), b: GUTTER } },
        item: { size }, contentAlign: 'fill' });
      await UI.attachRoot(win, root);
      await text(win, root, 'Authentication', TYPE.heading, width, 32);
      await label(win, root, active.message, TYPE.body, width, landscape ? 38 : 64, CREAM);
      await label(win, root, active.user, TYPE.caption, width, 24, MUTED);
      await label(win, root, active.question || '', TYPE.caption, width, 26, MUTED);
      if (!active.noInput) {
        const literal = echo || active.action.startsWith('org.koya.Askpass.') || active.user !== profile.UserName;
        input = await credentialInput(win, root, { width, value, mode: literal ? 'password' : mode || credentialMode(profile, active.user),
          profile: literal ? {} : profile, echo, placeholder: echo ? 'Enter response' : 'Enter password',
          compact: landscape, rowHeight: landscape ? 32 : 48, onSubmit: () => enqueue(submit), onCancel: cancel });
        await input.setEnabled(waiting && !sending); if (waiting) input.focus();
      }
      statusLabel = await label(win, root, active.status || '', TYPE.caption, width, 28, ORANGE);
      const actions = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.s }, item: { size: { x: width, y: 48 } } });
      await UI.attach(win, root, actions);
      const actionWidth = active.mode === 'none' ? width : (width - SPACE.s) / 2;
      if (active.mode !== 'none') await button(win, actions, 'Cancel', actionWidth, 48, cancel, { colour: CARD });
      const submitButton = await button(win, actions, '', actionWidth, 48, () => enqueue(submit), { colour: ORANGE });
      submitLabel = await text(win, submitButton, active.mode === 'confirm' ? 'Allow' : active.mode === 'none' ? 'Close' : 'Authenticate', TYPE.body, actionWidth, 48, INK);
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

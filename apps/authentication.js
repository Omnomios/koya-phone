import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Event from 'Helix/Event';
import * as Engine from 'Helix/Engine';
import * as Log from 'Helix/Log';
import { session as Bus } from 'Module/dbus';
import { keyboardVisible } from './session-keyboard.js';
import { button, icon, label, text } from './touch-ui.js';
import { CREAM, ORANGE, INK, CARD, MUTED, GUTTER, SPACE, RADIUS, TYPE, TOUCH } from './theme.js';

const NAME = 'org.koya.Shell1', PATH = '/org/koya/Shell1';
const call = (method, signature = '', ...args) => Bus.call(NAME, PATH, NAME, method, signature, ...args);
const clean = text => String(text || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512);

export default async () => {
  let win, root, entry, entryWidth, field, focusRing, caret, questionLabel, statusLabel, submitLabel, size, active, value = '', preedit = '';
  let displayName, displaySize;
  let focused = false, waiting = false, sending = false, echo = false, manualKeyboard = false;
  let queue = Promise.resolve();
  const enqueue = job => { queue = queue.then(job).catch(error => Log.error('Authentication dialog: ' + error)); return queue; };
  const keyboard = async visible => {
    if (!win) return;
    if (visible && !field) return;
    try {
      const supported = await Compositor.setTextInput(win, visible ? {
        enabled: true, newFocus: true, inputId: field, cursorElement: field,
        contentPurpose: echo ? 0 : 8, contentHint: echo ? 0 : 64 | 128
      } : { enabled: false });
      if (visible && !supported) { manualKeyboard = true; await keyboardVisible(true); }
      else if (!visible && manualKeyboard) { manualKeyboard = false; await keyboardVisible(false); }
    } catch (error) { Log.error('Authentication keyboard: ' + error); }
  };
  const paintField = async () => {
    if (field) {
      const shown = value + preedit;
      await UI.setTextString(win, field, shown ? echo ? shown : '•'.repeat(Array.from(shown).length)
        : focused ? '' : echo ? 'Enter response' : 'Enter password');
      await UI.setTextColour(win, field, shown || focused ? CREAM : MUTED);
      await UI.setEnabled(win, focusRing, focused && waiting);
      await UI.setEnabled(win, caret, focused && waiting);
      if (focused && waiting) {
        const position = await UI.getTextCaretPosition(win, field, Array.from(shown).length);
        await UI.setPosition(win, caret, { x: Math.min(entryWidth - 18, 14 + Number(position?.x || 0)), y: 0 });
      }
    }
    if (submitLabel) await UI.setTextString(win, submitLabel, sending ? 'Checking…'
      : active?.noInput ? active.mode === 'confirm' ? 'Allow' : 'Close' : 'Authenticate');
  };
  const closeSurface = async () => {
    await keyboard(false);
    if (win) await Promise.all([Compositor.setPointerEvents(win, false), Compositor.setKeyboardInteractivity(win, 'none')]);
    if (win) await Compositor.destroyWindow(win);
    win = root = entry = entryWidth = field = focusRing = caret = questionLabel = statusLabel = submitLabel = undefined;
  };
  const hide = async () => {
    active = undefined; value = preedit = ''; focused = waiting = sending = false;
    await closeSurface();
  };
  const cancel = () => {
    if (active) call('AuthenticationCancel', 'u', active.id).catch(error => Log.error('Authentication cancel: ' + error));
  };
  const submit = async () => {
    if (!active || !waiting || sending) return;
    const id = active.id, answer = value;
    sending = true; waiting = false; focused = false; value = preedit = '';
    await paintField();
    await UI.setTextString(win, statusLabel, 'Checking authentication…');
    await keyboard(false);
    try { await call('AuthenticationRespond', 'us', id, answer); }
    catch (error) {
      sending = false; waiting = true; focused = true;
      await UI.setTextString(win, statusLabel, 'Could not send the response. Try again.');
      await paintField(); await keyboard(true);
      Log.error('Authentication response: ' + error);
    }
  };
  const build = async () => {
    if (!win || !active) return;
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
      if (root) await UI.destroyElement(win, root);
      const landscape = displaySize.x > displaySize.y;
      const width = landscape ? size.x - 2 * GUTTER : Math.min(460, size.x - 2 * GUTTER);
      const top = landscape ? Math.min(40, Math.max(4, size.y - 150)) : Math.min(100, Math.round(size.y * 0.12));
      const height = landscape ? size.y - top - 4 : 390;
      const side = Math.round((size.x - width) / 2);
      root = await UI.createElement(win, {
        renderable: { type: 'box', colour: [0.015, 0.035, 0.025, 0.86] },
        layout: { type: 'column', padding: { l: side, r: side, t: top, b: 0 } },
        item: { size }, contentAlign: 'fill'
      });
      await UI.attachRoot(win, root);
      const card = await UI.createElement(win, {
        renderable: { type: 'box', colour: INK, cornerRadius: RADIUS.surface, cornerResolution: 16 },
        layout: { type: landscape ? 'row' : 'column', gap: SPACE.m,
          padding: { l: SPACE.l, r: SPACE.l, t: landscape ? SPACE.s : SPACE.l, b: landscape ? SPACE.s : SPACE.l } },
        item: { size: { x: width, y: height } }, contentAlign: 'fill'
      });
      await UI.attach(win, root, card);
      const inner = width - 2 * SPACE.l;
      let information = card, controls = card, informationWidth = inner, controlsWidth = inner;
      if (landscape) {
        informationWidth = Math.floor((inner - SPACE.m) * 0.48);
        controlsWidth = inner - SPACE.m - informationWidth;
        information = await UI.createElement(win, {
          layout: { type: 'column', gap: SPACE.xs }, item: { size: { x: informationWidth, y: height - 2 * SPACE.s } }
        });
        controls = await UI.createElement(win, {
          layout: { type: 'column', gap: SPACE.xs }, item: { size: { x: controlsWidth, y: height - 2 * SPACE.s } }
        });
        await UI.attach(win, card, information); await UI.attach(win, card, controls);
      }
      const headingHeight = landscape ? 28 : 48;
      const lockSize = landscape ? 22 : 30;
      const heading = await UI.createElement(win, {
        layout: { type: 'row', alignItems: 'center', gap: SPACE.m }, item: { size: { x: informationWidth, y: headingHeight } }
      });
      await UI.attach(win, information, heading);
      const lock = await icon(win, heading, '/rom/assets/power-menu/lock.png', lockSize, lockSize, headingHeight);
      await UI.setHitTarget(win, lock, false);
      await label(win, heading, landscape ? 'Authentication · ' + active.user : 'Authentication',
        landscape ? TYPE.heading : TYPE.title, informationWidth - lockSize - SPACE.m, headingHeight, CREAM);
      await label(win, information, active.message, TYPE.body, informationWidth, landscape ? 38 : 58, CREAM);
      if (!landscape) await label(win, information, 'As ' + active.user, TYPE.caption, informationWidth, 26, MUTED);
      questionLabel = await label(win, information, active.question || '', TYPE.caption + 1, informationWidth,
        landscape ? 50 : active.noInput ? 72 : 30, MUTED);
      field = undefined;
      if (!active.noInput) {
        const entryHeight = landscape ? 46 : 58;
        entryWidth = controlsWidth;
        entry = await UI.createElement(win, {
          renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.control, cornerResolution: 16 },
          item: { size: { x: controlsWidth, y: entryHeight } }, contentAlign: 'fill',
          onMouseDown: () => { if (waiting && !sending) { focused = true; enqueue(async () => { await paintField(); await keyboard(true); }); } }
        });
        await UI.attach(win, controls, entry); await UI.setElementId(win, entry, 'authentication-response');
        focusRing = await UI.createElement(win, {
          renderable: { type: 'box', colour: ORANGE, inset: 2, cornerRadius: RADIUS.control, cornerResolution: 16,
            aabb: { min: { x: 0, y: 0 }, max: { x: controlsWidth, y: entryHeight } } },
          item: { size: { x: controlsWidth, y: entryHeight } }, contentAlign: 'fill'
        });
        await UI.attach(win, entry, focusRing); await UI.setEnabled(win, focusRing, false);
        await UI.setHitTarget(win, focusRing, false);
        field = await label(win, entry, '', TYPE.body, controlsWidth - 28, entryHeight, CREAM);
        await UI.setPosition(win, field, { x: 14, y: 0 });
        await UI.setHitTarget(win, field, false);
        caret = await UI.createElement(win, {
          renderable: { type: 'box', colour: ORANGE, aabb: { min: { x: 0, y: 0 }, max: { x: 2, y: 26 } } },
          item: { size: { x: 2, y: entryHeight } }, contentAlign: { x: 'start', y: 'center' }
        });
        await UI.attach(win, entry, caret); await UI.setEnabled(win, caret, false);
        await UI.setHitTarget(win, caret, false);
      }
      statusLabel = await label(win, controls, active.status || '', TYPE.caption, controlsWidth, landscape ? 24 : 28, ORANGE);
      const actions = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.s }, item: { size: { x: controlsWidth, y: TOUCH } } });
      await UI.attach(win, controls, actions);
      const actionWidth = active.mode === 'none' ? controlsWidth : (controlsWidth - SPACE.s) / 2;
      if (active.mode !== 'none') await button(win, actions, 'Cancel', actionWidth, TOUCH, cancel, { colour: CARD });
      const submitButton = await button(win, actions, '', actionWidth, TOUCH, submit, { colour: ORANGE });
      submitLabel = await text(win, submitButton, '', TYPE.body, actionWidth, TOUCH, INK);
      await paintField();
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
  };
  const openSurface = async display => {
    const full = { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) };
    if (win && display.display === displayName && full.x === displaySize.x && full.y === displaySize.y) return;
    await closeSurface();
    // A new layer needs a new tap before it can claim keyboard focus.
    focused = false;
    displayName = display.display; displaySize = full;
    // Landscape Squeekboard begins around y=198 on the phone's 540px-high
    // logical display. Keep the layer entirely above its touch region.
    size = { x: full.x, y: Math.round(full.y * (full.x > full.y ? 0.35 : 0.60)) };
    win = await Compositor.createWindow({ role: 'overlay', anchor: 'top-left', display: display.display, size,
      namespace: 'koya-authentication', exclusiveZone: -1, msaaSamples: 1, transparent: true,
      renderingEnabled: false, keyboardInteractivity: 'on_demand', acceptPointerEvents: true });
    await Compositor.setClearColor(win, 0, 0, 0, 0);
    await build();
  };
  const begin = async (id, action, message, user) => {
    await hide();
    const mode = action.startsWith('org.koya.Askpass.') ? action.slice('org.koya.Askpass.'.length) : 'entry';
    active = { id, action, mode, noInput: mode === 'confirm' || mode === 'none',
      message: clean(message) || 'Administrator access is required.', user: clean(user), question: '', status: '' };
    const display = (await Compositor.listDisplays())[0];
    if (!display) { cancel(); return; }
    await openSurface(display);
  };
  const prompt = async (id, question, visible) => {
    if (!active || active.id !== id || !win) return;
    active.question = clean(question);
    value = preedit = ''; echo = !!visible; waiting = true; focused = sending = false;
    await UI.setTextString(win, questionLabel, active.question);
    await UI.setTextString(win, statusLabel, active.status);
    await paintField();
  };
  const insert = text => {
    if (!active || !waiting || !focused) return;
    if (/[\r\n]/.test(String(text || ''))) { enqueue(submit); return; }
    value = (value + clean(text)).slice(0, 512); preedit = '';
    enqueue(paintField);
  };
  Event.on('textInput', event => { if (event.id === win) insert(event.text); });
  Event.on('textRepeat', event => { if (event.id === win) insert(event.text); });
  Event.on('textInputMethod', event => {
    if (event.id !== win || event.inputId !== field || !waiting || !focused) return;
    if (/[\r\n]/.test(String(event.text || ''))) { enqueue(submit); return; }
    const chars = Array.from(value);
    let bytes = Number(event.beforeLength || 0);
    while (bytes > 0 && chars.length) {
      const point = chars.pop().codePointAt(0);
      bytes -= point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    value = (chars.join('') + clean(event.text)).slice(0, 512);
    preedit = clean(event.preedit);
    enqueue(paintField);
  });
  const keyDown = event => {
    if (event.id !== win) return;
    if (event.key === 65307) { cancel(); return; }
    if (!waiting || !focused) return;
    if ([14, 65288].includes(event.key)) { value = Array.from(value).slice(0, -1).join(''); preedit = ''; enqueue(paintField); }
    if ([28, 96, 65293].includes(event.key)) enqueue(submit);
  };
  Event.on('keyDown', keyDown);
  Event.on('keyRepeat', event => { if (event.id === win && [14, 65288].includes(event.key)) keyDown(event); });
  Event.on('windowResized', event => { if (event.id === win) enqueue(async () => {
    size = { x: event.width, y: event.height };
    await build(); if (waiting && focused) await keyboard(true);
  }); });
  let probing = false;
  setInterval(async () => {
    if (!active || !displaySize || probing) return;
    probing = true;
    try {
      const display = (await Compositor.listDisplays()).find(item => item.display === displayName);
      if (display && (Number(display.logical_width || display.width) !== displaySize.x ||
          Number(display.logical_height || display.height) !== displaySize.y)) enqueue(() => active ? openSurface(display) : undefined);
    } catch (error) { Log.error('Authentication display: ' + error); }
    finally { probing = false; }
  }, 250);
  setTimeout(async () => {
    try {
      await Bus.connect();
      Bus.onSignal(event => {
        if (event.interface === NAME) {
          const [id, first, second, third] = event.args || [];
          if (event.member === 'AuthenticationBegin') enqueue(() => begin(id, first, second, third));
          if (event.member === 'AuthenticationPrompt') enqueue(() => prompt(id, first, second));
          if (event.member === 'AuthenticationMessage') enqueue(async () => {
            if (active?.id !== id || !win) return;
            active.status = clean(first); await UI.setTextString(win, statusLabel, active.status);
            await UI.setTextColour(win, statusLabel, second ? ORANGE : MUTED);
          });
          if (event.member === 'AuthenticationEnd') enqueue(() => active?.id === id ? hide() : undefined);
        }
        if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged' &&
            event.args?.[0] === NAME && !event.args[2]) Engine.quit();
      });
      for (const member of ['AuthenticationBegin', 'AuthenticationPrompt', 'AuthenticationMessage', 'AuthenticationEnd'])
        await Bus.addMatch(`type='signal',sender='${NAME}',interface='${NAME}',member='${member}'`);
      await Bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.koya.Shell1'");
      await call('Ready', 's', 'authentication');
    } catch (error) { Log.error('Authentication setup: ' + error); Engine.quit(); }
  }, 0);
};

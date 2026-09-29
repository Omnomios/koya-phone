import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Engine from 'Helix/Engine';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import { windowLayout } from './window-layout.js';
import { wifiNetwork } from './wifi-network.js';
import { keyboardVisible } from './session-keyboard.js';
import { button, icon, text, label as textLabel, pill, toggle, sheetHeader } from './touch-ui.js';
import { clips } from './motion.js';
import { FONT, CREAM, ORANGE, INK, CARD, MUTED, CLEAR, BAR_HEIGHT, NAV_HEIGHT, GUTTER, SPACE, RADIUS, TYPE, HEADER_HEIGHT, TOUCH, TRAILING_INSET } from './theme.js';

const GHOST = { colour: CLEAR };
const ROW = 72, LOCK = 24, ROW_RIGHT = TRAILING_INSET - LOCK / 2;
const glyph = name => '/rom/assets/launcher/' + name + '.png';
export default async (options = {}) => {
  const display = (await Compositor.listDisplays())[0];
  const requested = { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) - BAR_HEIGHT - NAV_HEIGHT };
  const win = await Compositor.createWindow({ role: 'window', title: 'Wi-Fi', appId: 'org.koya.Wifi', msaaSamples: 1,
    size: requested, display: display.display, acceptPointerEvents: true });
  await Compositor.setWindowRenderingEnabled(win, false);
  await Compositor.setClearColor(win, ...INK);
  // Before the first configure, window info can report the whole output.
  // The tiled window is never taller than the space between the bars.
  const info = await Compositor.getWindowInfo(win), size = { x: info.width, y: Math.min(info.height, requested.y) };
  let width = size.x - 2 * GUTTER;
  const root = await UI.createElement(win, { item: { size } }); await UI.attachRoot(win, root);
  let board, modal, field, errorLabel, form, password = '', preedit = '', reveal = false, focused = false, page = 0, key;
  let entry, focusRing, caret, caretBlink, caretRunning = false, submitted = false;
  let manualKeyboard = false;
  let latest = { networks: [], loading: true }, queue = Promise.resolve();
  const enqueue = task => { queue = queue.then(task).catch(error => Log.error('Wi-Fi UI: ' + error)); return queue; };
  const backend = wifiNetwork(value => { latest = value; enqueue(paint); });
  const keyboard = async (visible, newFocus = false, changeCause = 'other') => {
    if (options.keyboard === false) return;
    try {
      const supported = await Compositor.setTextInput(win, visible ? {
        enabled: true, newFocus, inputId: field, cursorElement: field, changeCause,
        contentPurpose: 8, contentHint: 64 | 128
        // Passwords stay local: never provide surroundingText to input methods.
      } : { enabled: false });
      if (visible && !supported) { manualKeyboard = true; await keyboardVisible(true); }
      else if (!visible && manualKeyboard) { manualKeyboard = false; await keyboardVisible(false); }
    } catch (error) { Log.error('Wi-Fi text input: ' + error); }
  };
  const label = (parent, value, fontSize, w, h, colour = CREAM) => textLabel(win, parent, value, fontSize, w, h, colour);
  const closeForm = async () => {
    form = undefined; password = ''; preedit = ''; focused = false; submitted = false;
    // Restore the cached list before tearing down the sheet. Keyboard transport
    // must not occupy the UI queue or postpone the return to the list.
    keyboard(false);
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
      if (caret) await UI.stopAnimation(win, caret);
      caretRunning = false;
      if (board) await UI.setEnabled(win, board, true);
      if (modal) await UI.destroyElement(win, modal);
      modal = field = errorLabel = entry = focusRing = caret = caretBlink = undefined;
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
    backend.clearError();
  };
  const updateField = async (changeCause = 'other') => {
    if (!field) return;
    const value = password + preedit;
    const display = value ? reveal ? value : '•'.repeat(Array.from(value).length) : focused ? '' : 'Password';
    await UI.setTextString(win, field, display);
    await UI.setTextColour(win, field, value || focused ? CREAM : MUTED);
    await UI.setEnabled(win, focusRing, focused);
    const position = await UI.getTextCaretPosition(win, field, focused ? Array.from(display).length : 0);
    const x = Number(position?.x || 0), scroll = Math.max(0, x - (width - 36));
    await UI.setPosition(win, field, { x: -scroll, y: 0 });
    await UI.setPosition(win, caret, { x: x - scroll, y: 0 });
    const blinking = focused && !!form && !latest.working;
    await UI.setEnabled(win, caret, blinking);
    if (blinking !== caretRunning) {
      caretRunning = blinking;
      if (blinking) await caretBlink.play('blink');
      else await UI.stopAnimation(win, caret);
    }
    // Editable state is sent without waiting on a fallback D-Bus keyboard call.
    keyboard(blinking, false, changeCause);
  };
  const focusField = async () => {
    if (!form || latest.working) return;
    const newFocus = !focused;
    focused = true;
    await updateField();
    if (newFocus) keyboard(true, true);
  };
  const submit = async () => {
    if (!form || latest.working) return;
    const network = form, secret = password;
    submitted = true; focused = false;
    await enqueue(updateField);
    const accepted = await backend.connect(network, secret);
    if (form !== network) return;
    if (accepted) await enqueue(closeForm);
    else await enqueue(updateField);
  };
  const openForm = async (network, restore) => {
    if (latest.working && !restore) return;
    if (!restore) { await closeForm(); form = network; reveal = false; }
    else {
      if (caret) await UI.stopAnimation(win, caret);
      caretRunning = false;
      if (modal) await UI.destroyElement(win, modal);
    }
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
    if (board) await UI.setEnabled(win, board, false);
    modal = await UI.createElement(win, {
      renderable: { type: 'box', colour: INK }, item: { size, order: 1 }, contentAlign: 'fill', inheritAnimation: true,
      layout: { type: 'column', gap: SPACE.m, padding: { l: GUTTER, r: GUTTER, t: SPACE.s, b: 0 } }
    });
    await UI.attach(win, root, modal);
    const entrance = await clips(win, modal, { enter: [
      { time: 0, opacity: 0, position: { x: 0, y: 12 } },
      { time: 0.18, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }
    ] });
    await sheetHeader(win, modal, network.name, width, [{ icon: glyph('close'), handler: () => enqueue(closeForm) }]);
    entry = await UI.createElement(win, {
      renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.control, cornerResolution: 16 },
      item: { size: { x: width, y: 72 } }, contentAlign: 'fill',
      onMouseDown: () => enqueue(focusField)
    });
    await UI.attach(win, modal, entry); await UI.setElementId(win, entry, 'wifi-password');
    focusRing = await UI.createElement(win, {
      renderable: { type: 'box', colour: ORANGE, inset: 2, cornerRadius: RADIUS.control, cornerResolution: 16,
        aabb: { min: { x: 0, y: 0 }, max: { x: width, y: 72 } } },
      item: { size: { x: width, y: 72 } }, contentAlign: 'fill'
    });
    await UI.attach(win, entry, focusRing); await UI.setEnabled(win, focusRing, false);
    const viewport = await UI.createElement(win, { clipToBounds: true,
      item: { size: { x: width - 32, y: 72 }, margin: { l: 16, r: 16, t: 0, b: 0 } } });
    await UI.attach(win, entry, viewport);
    field = await UI.createElement(win, {
      // Line metrics keep the baseline and left edge fixed as characters are
      // typed; ink bounds would re-centre on every glyph's ascent and descent.
      renderable: { type: 'text', string: 'Password', size: 22, font: FONT, colour: MUTED, justify: 'left', vAlign: 'center', metricsBasis: 'line' },
      item: { size: { x: width - 32, y: 72 } }, contentAlign: { x: 'start', y: 'center' }, contentPositioning: 'raw'
    });
    await UI.attach(win, viewport, field);
    caret = await UI.createElement(win, {
      renderable: { type: 'box', colour: ORANGE,
        aabb: { min: { x: 0, y: 0 }, max: { x: 2, y: 28 } } },
      item: { size: { x: 2, y: 72 } }, contentAlign: { x: 'start', y: 'center' }, contentPositioning: 'raw'
    });
    await UI.attach(win, viewport, caret); await UI.setEnabled(win, caret, false);
    caretBlink = await clips(win, caret, { blink: [
      { time: 0, opacity: 1 }, { time: 0.45, opacity: 0, ease: 'inOutQuad' },
      { time: 0.9, opacity: 1, ease: 'inOutQuad', looping: true }
    ] });
    const helpers = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.s }, item: { size: { x: width, y: TOUCH } } });
    await UI.attach(win, modal, helpers);
    await pill(win, helpers, 'Paste', 96, async () => {
      if (latest.working) return;
      try { password = (await Compositor.getClipboardText()).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512); preedit = ''; await enqueue(updateField); }
      catch (_) { await UI.setTextString(win, errorLabel, 'Clipboard unavailable'); }
    });
    await pill(win, helpers, 'Show / hide', 128, () => { reveal = !reveal; return enqueue(updateField); });
    errorLabel = await label(modal, '', TYPE.caption + 1, width, 40, ORANGE);
    // The one primary action on screen: filled, full width, thumb height.
    await pill(win, modal, 'Connect', width, submit, { colour: ORANGE, labelColour: INK, height: 56, size: TYPE.body + 1 });
    // The field gains editable focus and activates the OSK when tapped.
    await updateField();
    await entrance.play('enter');
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
  };
  const select = async network => {
    if (latest.working) return;
    if (!network.supported) return;
    if (network.connected) return;
    if (network.password && !network.saved) { enqueue(() => openForm(network)); return; }
    if (!await backend.connect(network) && network.password) enqueue(() => openForm(network));
  };
  async function paint() {
    if (form) {
      if (errorLabel) await UI.setTextString(win, errorLabel, submitted ? latest.error || (latest.working ? latest.message : '') : '');
      return; // Keep the list intact underneath the sheet, including its layout.
    }
    // Header, status line and footer are fixed; the list takes what remains,
    // so Refresh and the pager always stay on screen.
    const listHeight = size.y - SPACE.s - GUTTER - HEADER_HEIGHT - 32 - TOUCH - 3 * SPACE.m;
    const count = Math.max(1, Math.floor((listHeight + SPACE.s) / (ROW + SPACE.s)));
    const pages = Math.max(1, Math.ceil(latest.networks.length / count)); page = Math.min(page, pages - 1);
    const nextKey = JSON.stringify([page, latest]); if (key === nextKey) return; key = nextKey;
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
    if (board) await UI.destroyElement(win, board);
    board = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.m, padding: { l: GUTTER, r: GUTTER, t: SPACE.s, b: GUTTER } }, item: { size } });
    await UI.attach(win, root, board);
    if (form) await UI.setEnabled(win, board, false);
    // Keep the password sheet above a rebuilt network list.
    if (modal) { await UI.detach(win, modal); await UI.attach(win, root, modal); }
    await sheetHeader(win, board, 'Wi-Fi', width, [{ icon: glyph('close'), handler: () => { backend.dispose(); keyboard(false); Engine.quit(); } }],
      { width: 68, build: async row => {
        const power = await toggle(win, row, !!latest.enabled, () => { if (latest.working) return; power.set(!latest.enabled); backend.toggle(); });
        await UI.setElementId(win, power.id, 'wifi-power');
      } });
    const status = latest.loading ? 'Finding networks…' : latest.error || latest.message || (!latest.hardware ? 'Wi-Fi is blocked by the device' : !latest.enabled ? 'Wi-Fi is off' : latest.scanning ? 'Finding networks…' : 'Available networks');
    await label(board, status, TYPE.caption + 1, width, 32, latest.error ? ORANGE : MUTED);
    const list = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: width, y: listHeight } } });
    await UI.attach(win, board, list);
    const visible = latest.enabled ? latest.networks.slice(page * count, (page + 1) * count) : [];
    if (!visible.length && !latest.loading) await text(win, list, latest.enabled ? 'No networks found' : 'Turn Wi-Fi on to find networks', TYPE.body, width, 120, MUTED);
    for (const network of visible) {
      const row = await UI.createElement(win, { renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.surface, cornerResolution: 16, origin: { x: 0.5, y: 0.5 } },
        layout: { type: 'row', gap: SPACE.s, alignItems: 'center', padding: { l: 16, r: ROW_RIGHT, t: 0, b: 0 } }, item: { size: { x: width, y: ROW } }, contentAlign: 'fill' });
      await UI.attach(win, list, row);
      // Every row ends in the same lock slot, so locks line up whether or not
      // the row carries Disconnect/Forget; those sit just before the slot.
      const trailing = (network.connected ? 116 + SPACE.s : 0) + (network.saved ? 80 + SPACE.s : 0) + SPACE.s + LOCK;
      const mainWidth = width - 16 - ROW_RIGHT - trailing;
      const target = await UI.createElement(win, {
        renderable: { type: 'box', colour: CLEAR, origin: { x: 0.5, y: 0.5 } },
        layout: { type: 'row', gap: SPACE.m, alignItems: 'center' }, item: { size: { x: mainWidth, y: ROW } },
        onMouseClick: () => select(network)
      });
      await UI.attach(win, row, target); await UI.setElementId(win, target, 'wifi-network-' + network.path.split('/').pop());
      const feedback = await clips(win, target, {
        press: [{ time: 0.07, scale: { x: 0.98, y: 0.98 }, ease: 'outQuad' }],
        release: [{ time: 0.10, scale: { x: 1.01, y: 1.01 }, ease: 'outCubic' }, { time: 0.22, scale: { x: 1, y: 1 }, ease: 'outCubic' }]
      });
      await UI.setOnMouseDown(win, target, () => !latest.working && feedback.play('press'));
      await UI.setOnMouseUp(win, target, () => feedback.play('release'));
      await UI.setOnMouseExit(win, target, () => feedback.play('release'));
      await icon(win, target, '/rom/assets/status/wifi-' + Math.max(0, Math.min(3, Math.ceil(Number(network.Strength) * 3 / 100))) + '.png', 26, 36, ROW);
      const detailWidth = mainWidth - 36 - SPACE.m;
      const detail = await UI.createElement(win, { layout: { type: 'column', justifyContent: 'center' }, item: { size: { x: detailWidth, y: ROW } } });
      await UI.attach(win, target, detail);
      await label(detail, network.name, TYPE.body + 1, detailWidth, 28);
      await label(detail, network.connected ? 'Connected' : network.saved ? 'Saved' : network.security === 'open' ? 'Open' : network.security === 'owe' ? 'Encrypted' : !network.supported ? 'Enterprise / WEP setup unavailable' : 'Password required', TYPE.caption, detailWidth, 22, network.connected ? ORANGE : MUTED);
      if (network.connected) {
        const disconnect = await pill(win, row, 'Disconnect', 116, () => backend.disconnect(), { height: 40, labelColour: ORANGE });
        await UI.setElementId(win, disconnect, 'wifi-disconnect-' + network.path.split('/').pop());
      }
      if (network.saved) {
        const forget = await pill(win, row, 'Forget', 80, () => backend.forget(network), { height: 40 });
        await UI.setElementId(win, forget, 'wifi-forget-' + network.path.split('/').pop());
      }
      const lock = await UI.createElement(win, { layout: { type: 'row', justifyContent: 'center', alignItems: 'center' },
        item: { size: { x: LOCK, y: ROW } }, onMouseClick: () => select(network) });
      await UI.attach(win, row, lock);
      if (network.security !== 'open') await icon(win, lock, '/rom/assets/power-menu/lock.png', 18, LOCK, ROW);
    }
    const footer = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.s, alignItems: 'center' }, item: { size: { x: width, y: TOUCH } } });
    await UI.attach(win, board, footer);
    await pill(win, footer, latest.scanning ? 'Scanning…' : 'Refresh', 128, () => backend.scan(), { labelColour: ORANGE });
    if (latest.working) await pill(win, footer, 'Cancel', 96, () => backend.disconnect());
    else if (pages > 1) {
      await UI.attach(win, footer, await UI.createElement(win, { item: { size: { x: width - 128 - 64 * 2 - 64 - SPACE.s * 4, y: TOUCH } } }));
      await button(win, footer, '', 64, TOUCH, () => { page = Math.max(0, page - 1); enqueue(paint); }, { ...GHOST, icon: glyph('previous'), iconSize: 22, radius: RADIUS.control });
      await text(win, footer, (page + 1) + ' / ' + pages, TYPE.caption, 64, TOUCH, MUTED);
      await button(win, footer, '', 64, TOUCH, () => { page = Math.min(pages - 1, page + 1); enqueue(paint); }, { ...GHOST, icon: glyph('next'), iconSize: 22, radius: RADIUS.control });
    }
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
  }
  const insert = value => {
    if (!focused || !form || latest.working) return;
    preedit = ''; password = (password + value.replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 512); enqueue(updateField);
  };
  Event.on('textInput', event => { if (event.id === win) insert(event.text); });
  Event.on('textRepeat', event => { if (event.id === win) insert(event.text); });
  Event.on('textInputMethod', event => {
    if (event.id !== win || event.inputId !== field || !focused || !form || latest.working) return;
    // This field keeps its cursor at the end. IME deletion lengths are UTF-8
    // bytes, not JavaScript string indices; commit and deletion form one edit.
    const characters = Array.from(password);
    let remaining = Number(event.beforeLength || 0);
    while (remaining > 0 && characters.length) {
      const point = characters.pop().codePointAt(0);
      remaining -= point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    password = (characters.join('') + (event.text || '').replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 512);
    preedit = (event.preedit || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512);
    enqueue(() => updateField('input_method'));
  });
  const keyDown = event => {
    if (event.id !== win) return;
    if ([1, 65307].includes(event.key)) { if (form) enqueue(closeForm); else { backend.dispose(); Engine.quit(); } }
    if (!focused || !form || latest.working) return;
    if ([14, 65288].includes(event.key)) { preedit = ''; password = Array.from(password).slice(0, -1).join(''); enqueue(updateField); }
    if ([28, 96, 65293].includes(event.key)) submit();
  };
  Event.on('keyDown', keyDown); Event.on('keyRepeat', event => { if ([14, 65288].includes(event.key)) keyDown(event); });
  windowLayout(win, next => enqueue(async () => {
    Object.assign(size, next); width = next.x - 2 * GUTTER;
    await UI.setLayoutSize(win, root, next);
    key = undefined;
    if (form) await openForm(form, true);
    else await paint();
  }));
  await paint(); await Compositor.setWindowRenderingEnabled(win, true);
  // Native promises need the running engine event loop.
  setTimeout(() => backend.start().catch(() => { latest = { ...latest, loading: false, error: 'NetworkManager is unavailable' }; enqueue(paint); }), 0);
  globalThis.koyaWifi = { backend, select, openForm, closeForm, get window() { return win; }, get password() { return password; },
    setPassword: value => { password = value; return enqueue(updateField); }, submit };
  return win;
};

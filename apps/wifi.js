import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Engine from 'Helix/Engine';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import { wifiNetwork } from './wifi-network.js';
import { keyboardVisible } from './session-keyboard.js';
import { button, icon, text } from './touch-ui.js';
import { clips } from './motion.js';
import { FONT, CREAM, ORANGE, INK, BAR_HEIGHT, NAV_HEIGHT } from './theme.js';

const CARD = [0.095, 0.18, 0.14, 1], MUTED = [0.66, 0.72, 0.66, 1];
const GHOST = { colour: [0, 0, 0, 0] };
const glyph = name => '/rom/assets/launcher/' + name + '.png';
export default async (options = {}) => {
  const display = (await Compositor.listDisplays())[0];
  const win = await Compositor.createWindow({ role: 'window', title: 'Wi-Fi', appId: 'org.koya.Wifi', msaaSamples: 1,
    size: { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) - BAR_HEIGHT - NAV_HEIGHT },
    display: display.display, acceptPointerEvents: true });
  await Compositor.setWindowRenderingEnabled(win, false);
  await Compositor.setClearColor(win, ...INK);
  const info = await Compositor.getWindowInfo(win), size = { x: info.width, y: info.height }, width = size.x - 48;
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
  const label = async (parent, value, fontSize, w, h, colour = CREAM) => {
    const id = await UI.createElement(win, { renderable: { type: 'text', string: value, size: fontSize, font: FONT, colour, layoutMode: 'word-wrap' },
      item: { size: { x: w, y: h } }, contentAlign: { x: 'start', y: 'center' }, clipToBounds: true });
    await UI.attach(win, parent, id); await UI.setTextVerticalAlign(win, id, 'center'); return id;
  };
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
  const openForm = async network => {
    if (latest.working) return;
    await closeForm(); form = network; reveal = false;
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
    if (board) await UI.setEnabled(win, board, false);
    modal = await UI.createElement(win, {
      renderable: { type: 'box', colour: INK }, item: { size, order: 1 }, contentAlign: 'fill', inheritAnimation: true,
      layout: { type: 'column', gap: 12, padding: { l: 24, r: 24, t: 24, b: 0 } }
    });
    await UI.attach(win, root, modal);
    const entrance = await clips(win, modal, { enter: [
      { time: 0, opacity: 0, position: { x: 0, y: 12 } },
      { time: 0.18, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }
    ] });
    const heading = await UI.createElement(win, { layout: { type: 'row', gap: 8 }, item: { size: { x: width, y: 64 } } });
    await UI.attach(win, modal, heading);
    await label(heading, network.name, 28, width - 72, 64);
    await button(win, heading, '', 64, 64, () => enqueue(closeForm), { ...GHOST, icon: glyph('close'), iconSize: 24 });
    entry = await UI.createElement(win, {
      renderable: { type: 'box', colour: CARD, cornerRadius: 16, cornerResolution: 16 },
      item: { size: { x: width, y: 72 } }, contentAlign: 'fill',
      onMouseDown: () => enqueue(focusField)
    });
    await UI.attach(win, modal, entry); await UI.setElementId(win, entry, 'wifi-password');
    focusRing = await UI.createElement(win, {
      renderable: { type: 'box', colour: ORANGE, inset: 2, cornerRadius: 16, cornerResolution: 16,
        aabb: { min: { x: 0, y: 0 }, max: { x: width, y: 72 } } },
      item: { size: { x: width, y: 72 } }, contentAlign: 'fill'
    });
    await UI.attach(win, entry, focusRing); await UI.setEnabled(win, focusRing, false);
    const viewport = await UI.createElement(win, { clipToBounds: true,
      item: { size: { x: width - 32, y: 72 }, margin: { l: 16, r: 16, t: 0, b: 0 } } });
    await UI.attach(win, entry, viewport);
    field = await UI.createElement(win, {
      renderable: { type: 'text', string: 'Password', size: 22, font: FONT, colour: MUTED },
      item: { size: { x: width - 32, y: 72 } }, contentAlign: { x: 'start', y: 'center' }, contentPositioning: 'raw'
    });
    await UI.attach(win, viewport, field); await UI.setTextVerticalAlign(win, field, 'center');
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
    const helpers = await UI.createElement(win, { layout: { type: 'row', gap: 16 }, item: { size: { x: width, y: 56 } } });
    await UI.attach(win, modal, helpers);
    await button(win, helpers, 'Paste', 100, 56, async () => {
      if (latest.working) return;
      try { password = (await Compositor.getClipboardText()).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512); preedit = ''; await enqueue(updateField); }
      catch (_) { await UI.setTextString(win, errorLabel, 'Clipboard unavailable'); }
    }, GHOST);
    await button(win, helpers, 'Show / hide', 160, 56, () => { reveal = !reveal; return enqueue(updateField); }, GHOST);
    errorLabel = await label(modal, '', 17, width, 48, ORANGE);
    await button(win, modal, 'Connect', width, 64, submit, { colour: CARD, labelColour: ORANGE, size: 22 });
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
    const count = Math.max(1, Math.floor((size.y - 260) / 84));
    const pages = Math.max(1, Math.ceil(latest.networks.length / count)); page = Math.min(page, pages - 1);
    const nextKey = JSON.stringify([page, latest]); if (key === nextKey) return; key = nextKey;
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
    if (board) await UI.destroyElement(win, board);
    board = await UI.createElement(win, { layout: { type: 'column', gap: 12, padding: { l: 24, r: 24, t: 20, b: 20 } }, item: { size } });
    await UI.attach(win, root, board);
    if (form) await UI.setEnabled(win, board, false);
    // Keep the password sheet above a rebuilt network list.
    if (modal) { await UI.detach(win, modal); await UI.attach(win, root, modal); }
    const header = await UI.createElement(win, { layout: { type: 'row', gap: 8 }, item: { size: { x: width, y: 64 } } });
    await UI.attach(win, board, header);
    await label(header, 'Wi-Fi', 32, width - 152, 64);
    await button(win, header, latest.enabled ? 'On' : 'Off', 72, 64, () => backend.toggle(), { ...GHOST, labelColour: latest.enabled ? ORANGE : CREAM });
    await button(win, header, '', 64, 64, () => { backend.dispose(); keyboard(false); Engine.quit(); }, { ...GHOST, icon: glyph('close'), iconSize: 24 });
    const status = latest.loading ? 'Finding networks…' : latest.error || latest.message || (!latest.hardware ? 'Wi-Fi is blocked by the device' : !latest.enabled ? 'Wi-Fi is off' : latest.scanning ? 'Finding networks…' : 'Available networks');
    await label(board, status, 18, width, 48, latest.error ? ORANGE : MUTED);
    const list = await UI.createElement(win, { layout: { type: 'column', gap: 12 }, item: { size: { x: width, y: count * 84 } } });
    await UI.attach(win, board, list);
    const visible = latest.enabled ? latest.networks.slice(page * count, (page + 1) * count) : [];
    if (!visible.length && !latest.loading) await text(win, list, latest.enabled ? 'No networks found' : 'Turn Wi-Fi on to find networks', 22, width, 100, MUTED);
    for (const network of visible) {
      const row = await UI.createElement(win, { renderable: { type: 'box', colour: CARD, cornerRadius: 16, cornerResolution: 16, origin: { x: 0.5, y: 0.5 } },
        layout: { type: 'row', gap: 12, padding: { l: 16, r: 16, t: 0, b: 0 } }, item: { size: { x: width, y: 72 } }, contentAlign: 'fill' });
      await UI.attach(win, list, row);
      const mainWidth = width - 32 - (network.connected ? 108 : 0) - (network.saved ? 84 : 0);
      const target = await UI.createElement(win, {
        renderable: { type: 'box', colour: [0, 0, 0, 0], origin: { x: 0.5, y: 0.5 } },
        layout: { type: 'row', gap: 12 }, item: { size: { x: mainWidth, y: 72 } },
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
      await icon(win, target, '/rom/assets/status/wifi-' + Math.max(0, Math.min(3, Math.ceil(Number(network.Strength) * 3 / 100))) + '.png', 28, 36, 72);
      const detailWidth = mainWidth - 48 - (network.security !== 'open' ? 32 : 0);
      const detail = await UI.createElement(win, { layout: { type: 'column', justifyContent: 'center', gap: 2 }, item: { size: { x: detailWidth, y: 72 } } });
      await UI.attach(win, target, detail);
      await label(detail, network.name, 22, detailWidth, 32);
      await label(detail, network.connected ? 'Connected' : network.saved ? 'Saved' : network.security === 'open' ? 'Open' : network.security === 'owe' ? 'Encrypted' : !network.supported ? 'Enterprise / WEP setup unavailable' : 'Password required', 15, detailWidth, 24, network.connected ? ORANGE : MUTED);
      if (network.security !== 'open') await icon(win, target, '/rom/assets/power-menu/lock.png', 20, 20, 72);
      if (network.connected) {
        const disconnect = await button(win, row, 'Disconnect', 96, 72, () => backend.disconnect(), { ...GHOST, size: 15, labelColour: ORANGE });
        await UI.setElementId(win, disconnect, 'wifi-disconnect-' + network.path.split('/').pop());
      }
      if (network.saved) {
        const forget = await button(win, row, 'Forget', 72, 72, () => backend.forget(network), { ...GHOST, size: 15 });
        await UI.setElementId(win, forget, 'wifi-forget-' + network.path.split('/').pop());
      }
    }
    const footer = await UI.createElement(win, { layout: { type: 'row', gap: 12 }, item: { size: { x: width, y: 64 } } });
    await UI.attach(win, board, footer);
    await button(win, footer, latest.scanning ? 'Scanning…' : 'Refresh', 152, 64, () => backend.scan(), { ...GHOST, labelColour: ORANGE });
    if (latest.working) await button(win, footer, 'Cancel', 100, 64, () => backend.disconnect(), GHOST);
    else if (pages > 1) {
      await button(win, footer, '‹', 64, 64, () => { page = Math.max(0, page - 1); enqueue(paint); }, { ...GHOST, size: 30 });
      await text(win, footer, (page + 1) + '/' + pages, 17, 64, 64, MUTED);
      await button(win, footer, '›', 64, 64, () => { page = Math.min(pages - 1, page + 1); enqueue(paint); }, { ...GHOST, size: 30 });
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
  await paint(); await Compositor.setWindowRenderingEnabled(win, true);
  // Native promises need the running engine event loop.
  setTimeout(() => backend.start().catch(() => { latest = { ...latest, loading: false, error: 'NetworkManager is unavailable' }; enqueue(paint); }), 0);
  globalThis.koyaWifi = { backend, select, openForm, closeForm, get window() { return win; }, get password() { return password; },
    setPassword: value => { password = value; return enqueue(updateField); }, submit };
  return win;
};

import * as UI from 'Helix/UserInterface';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import * as Credentials from 'Module/credentials';
import { button, text } from './touch-ui.js';
import { clips } from './motion.js';
import { FONT, FONT_STRONG, CREAM, ORANGE, INK, CARD, TONAL, MUTED, CLEAR, alpha, SPACE, RADIUS, TYPE } from './theme.js';
import { cleanCredential, credentialAnswer, pinSalt } from './credential-model.js';

// Koya's own keyboard. A locked session hides layer-shell keyboards, so the
// lock screen, the authentication dialog and Settings draw this one instead.
// It is built like a phone keyboard: a tray docked to the bottom edge, keys
// on a 10-unit grid with a staggered middle row, wide modifiers, a preview
// bubble that pops out above the pressed key, and an Enter key that carries
// the screen's action. All layouts have four rows, so the tray never resizes.

const KEY = [0.19, 0.28, 0.23, 1];        // character keys
const MODIFIER = [0.12, 0.2, 0.16, 1];    // shift, layout, backspace
const TRAY = [0.035, 0.07, 0.055, 0.96];  // the keyboard's own surface
const BUBBLE = [0.26, 0.36, 0.3, 1];      // key preview, lighter than keys
const BACKSPACE = '⌫', SHIFT = '⇧', ENTER = '↵', SPACE_KEY = 'space';

// Rows are [label, units] pairs; a bare string is one unit per character.
const LETTERS = [
  'qwertyuiop',
  [['', 0.5], ...Array.from('asdfghjkl', c => [c, 1]), ['', 0.5]],
  [[SHIFT, 1.5], ...Array.from('zxcvbnm', c => [c, 1]), [BACKSPACE, 1.5]],
  [['123', 1.5], [',', 1], [SPACE_KEY, 4.5], ['.', 1], [ENTER, 2]]
];
const SYMBOLS = [
  '1234567890',
  '@#$_&-+()/',
  [['=\\<', 1.5], ...Array.from('*"\':;!?', c => [c, 1]), [BACKSPACE, 1.5]],
  [['ABC', 1.5], [',', 1], [SPACE_KEY, 4.5], ['.', 1], [ENTER, 2]]
];
// The rest of printable ASCII, so any password can be typed.
const MORE = [
  '~`|\\{}[]<>',
  [['', 3.5], ['%', 1], ['^', 1], ['=', 1], ['', 3.5]],
  [['?123', 1.5], ['', 7], [BACKSPACE, 1.5]],
  [['ABC', 1.5], [',', 1], [SPACE_KEY, 4.5], ['.', 1], [ENTER, 2]]
];
const PIN = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], [BACKSPACE, ''], ['0', '+'], [ENTER, '']];
const MODIFIERS = new Set([SHIFT, BACKSPACE, '123', '?123', 'ABC', '=\\<']);
const rowsOf = layout => layout.map(row => Array.isArray(row) ? row : Array.from(row, c => [c, 1]));

const fields = new Set();
const dispatch = (event, kind) => {
  for (const field of fields) if (field.win === event.id && field.focused && field.enabled) field[kind](event);
};
Event.on('textInput', event => dispatch(event, 'insert'));
Event.on('textRepeat', event => dispatch(event, 'insert'));
Event.on('keyDown', event => dispatch(event, 'key'));
Event.on('keyRepeat', event => { if ([14, 65288].includes(event.key)) dispatch(event, 'key'); });

// Height of the docked tray for a window size, so callers can lay out the
// rest of the screen above it.
export const credentialKeyboardHeight = (size, options = {}) => {
  const metrics = trayMetrics(size, options);
  return metrics.top + 4 * metrics.keyHeight + 3 * metrics.rowGap + metrics.bottom;
};
function trayMetrics(size, options = {}) {
  const short = size.x > size.y || size.y < 700;
  return { keyHeight: options.rowHeight || (short ? 36 : 50), rowGap: short ? 6 : 8, keyGap: short ? 5 : 6,
    side: short ? 8 : 4, top: short ? 8 : 10, bottom: short ? 8 : 14 };
}

export async function credentialInput(win, parent, options) {
  let value = cleanCredential(options.value), mode = options.mode || 'password', shifted = false, layout = 'letters';
  let width = options.width, keyboardShown = options.keyboard !== false;
  const docked = !!options.dock;
  const compact = !!options.compact && !docked;
  const entryWidth = compact ? Math.min(240, Math.round(width * 0.28)) : width;
  const trayWidth = docked ? options.dock.size.x : compact ? width - entryWidth - SPACE.m : width;
  const metrics = trayMetrics(docked ? options.dock.size : { x: trayWidth, y: compact ? 400 : 900 }, options);
  const trayHeight = metrics.top + 4 * metrics.keyHeight + 3 * metrics.rowGap + metrics.bottom;
  let queue = Promise.resolve(), disposed = false;
  const enqueue = job => queue = queue.then(() => !disposed && job()).catch(() => Log.error('Credential input could not update'));
  const hasSelector = !options.echo && options.allowMode !== false && !!pinSalt(options.profile || {});
  const FIELD = 56, SELECTOR = 36;
  const entryHeight = FIELD + (hasSelector ? SPACE.s + SELECTOR : 0);
  const inlineTray = docked ? 0 : trayHeight;
  const totalHeight = compact ? Math.max(entryHeight, inlineTray) : entryHeight + (docked ? 0 : SPACE.m + inlineTray);

  const root = await UI.createElement(win, { layout: { type: compact ? 'row' : 'column', gap: compact ? SPACE.m : SPACE.m }, item: { size: { x: width, y: totalHeight } } });
  await UI.attach(win, parent, root);
  const entryHost = compact || hasSelector ? await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: entryWidth, y: entryHeight } } }) : root;
  if (entryHost !== root) await UI.attach(win, root, entryHost);

  // ---- Field -------------------------------------------------------------
  // Layout-less frame: the field, its focus ring and its text share bounds.
  const entry = await UI.createElement(win, {
    renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.control, cornerResolution: 16, origin: { x: 0.5, y: 0.5 } },
    item: { size: { x: entryWidth, y: FIELD } }, contentAlign: 'fill', inheritAnimation: true,
    onMouseDown: () => input.focus() });
  await UI.attach(win, entryHost, entry);
  await UI.setElementId(win, entry, options.id || 'credential-response');
  const ring = await UI.createElement(win, { renderable: { type: 'box', colour: ORANGE, inset: 2, cornerRadius: RADIUS.control, cornerResolution: 16,
    aabb: { min: { x: 0, y: 0 }, max: { x: entryWidth, y: FIELD } } }, item: { size: { x: entryWidth, y: FIELD } }, contentAlign: 'fill' });
  await UI.attach(win, entry, ring);
  await UI.setHitTarget(win, ring, false);
  const field = await text(win, entry, '', TYPE.body + 2, entryWidth, FIELD, CREAM);
  await UI.setHitTarget(win, field, false);
  const fieldMotion = await clips(win, entry, {
    shake: [-10, 9, -6, 4, -2, 0].map((x, i) => ({ time: 0.045 * (i + 1), position: { x, y: 0 }, ease: 'inOutQuad' })),
    nudge: [{ time: 0.06, scale: { x: 1.012, y: 1.04 }, ease: 'outQuad' }, { time: 0.18, scale: { x: 1, y: 1 }, ease: 'outCubic' }]
  });
  const placeholder = () => mode !== 'password' ? 'Enter PIN' : options.placeholder || 'Enter password';
  const paint = async () => {
    // PIN digits read as spaced dots; passwords as a run of bullets.
    const count = Array.from(value).length;
    const shown = value ? options.echo ? value : (mode !== 'password' ? Array(count).fill('●').join(' ') : '•'.repeat(count)) : placeholder();
    await UI.setTextString(win, field, shown);
    await UI.setTextColour(win, field, value ? CREAM : MUTED);
    await UI.setEnabled(win, ring, input.focused && input.enabled);
  };
  const update = (grow = false) => { enqueue(paint); if (grow) fieldMotion.play('nudge'); options.onChange?.(value); };
  const submit = () => input.enabled && options.onSubmit?.();
  const backspace = () => { if (!value) return; value = Array.from(value).slice(0, -1).join(''); update(); };
  const insert = chars => {
    if (!input.enabled) return;
    if (/[\r\n]/.test(chars)) { submit(); return; }
    chars = cleanCredential(chars);
    if (mode !== 'password') chars = chars.replace(/\D/g, '');
    if (!chars) return;
    value += chars;
    if (mode !== 'password') value = value.slice(0, 12);
    update(true);
  };

  // ---- Mode switch -------------------------------------------------------
  // Segmented control: a highlight slides to the chosen credential type.
  let segments, highlight;
  const choices = ['password', 'pin'];
  if (hasSelector && options.profile.AuthenticationMode === 'pin' && options.profile.PendingAuthenticationMode === 'pin'
    && options.profile.AuthenticationSalt !== options.profile.PendingAuthenticationSalt) choices.push('pin-pending');
  const segmentWidth = (entryWidth - 4) / choices.length;

  // ---- Keyboard tray -----------------------------------------------------
  // Docked: a full-width tray at the window's bottom edge. Inline: the same
  // tray as a surface inside the caller's column.
  const host = docked ? options.dock.parent : root;
  const tray = await UI.createElement(win, {
    renderable: { type: 'box', colour: TRAY, cornerRadius: docked ? 0 : RADIUS.surface, cornerResolution: 16 },
    item: docked ? { position: { x: 0, y: options.dock.size.y - trayHeight }, size: { x: trayWidth, y: trayHeight } } : { size: { x: trayWidth, y: trayHeight } },
    contentAlign: 'fill', inheritAnimation: true });
  await UI.attach(win, host, tray);
  await UI.setElementId(win, tray, (options.id || 'credential') + '-keyboard');
  if (docked) {
    // A hairline lip separates the tray from whatever sits behind it.
    const lip = await UI.createElement(win, { renderable: { type: 'box', colour: alpha(CREAM, 0.08) },
      item: { position: { x: 0, y: 0 }, size: { x: trayWidth, y: 1 } }, contentAlign: 'fill' });
    await UI.attach(win, tray, lip);
  }
  const trayMotion = await clips(win, tray, {
    enter: [{ time: 0, position: { x: 0, y: trayHeight }, opacity: 1 }, { time: 0.3, position: { x: 0, y: 0 }, opacity: 1, ease: 'outCubic' }],
    show: [{ time: 0.22, position: { x: 0, y: 0 }, opacity: 1, ease: 'outCubic' }],
    hide: [{ time: 0.18, position: { x: 0, y: trayHeight * 0.4 }, opacity: 0.35, ease: 'inQuad' }],
    leave: [{ time: 0.2, position: { x: 0, y: trayHeight }, ease: 'inQuad' }]
  });
  let keys, bubble, bubbleText, letterLabels = [], shiftLabel;
  const unit = (trayWidth - 2 * metrics.side - 9 * metrics.keyGap) / 10;
  const keyColour = label => label === ENTER ? ORANGE : MODIFIERS.has(label) ? MODIFIER : KEY;

  // Preview bubble: pops out above the pressed key, outside the tray.
  const showBubble = async (label, x, y, w) => {
    const bw = Math.max(w * 1.3, 44), bh = metrics.keyHeight * 1.3;
    // Centred over the key, but kept inside the tray at the screen edges.
    const left = Math.max(2, Math.min(trayWidth - bw - 2, x + w / 2 - bw / 2));
    await UI.setLayoutPosition(win, bubble, { x: left, y: y - bh - 6 });
    await UI.setLayoutSize(win, bubble, { x: bw, y: bh });
    await UI.setTextString(win, bubbleText, label);
    await UI.setEnabled(win, bubble, true);
    await bubbleMotion.play('pop');
  };
  const hideBubble = () => UI.setEnabled(win, bubble, false).catch(() => {});
  let bubbleMotion;
  let repeat;
  const stopRepeat = () => { clearTimeout(repeat); repeat = undefined; };
  const press = label => {
    if (!input.enabled) return;
    input.focus();
    if (label === ENTER) submit();
    else if (label === SHIFT) { shifted = !shifted; enqueue(relabel); }
    else if (label === '123' || label === '?123') { layout = 'symbols'; enqueue(drawKeys); }
    else if (label === '=\\<') { layout = 'more'; enqueue(drawKeys); }
    else if (label === 'ABC') { layout = 'letters'; enqueue(drawKeys); }
    else if (label === BACKSPACE) return;
    else {
      insert(label === SPACE_KEY ? ' ' : label);
      // Shift is one-shot, as on a phone.
      if (shifted && layout === 'letters') { shifted = false; enqueue(relabel); }
    }
  };
  const relabel = async () => {
    for (const { id, label } of letterLabels) await UI.setTextString(win, id, shifted ? label.toUpperCase() : label);
    if (shiftLabel) await UI.setTextColour(win, shiftLabel, shifted ? ORANGE : CREAM);
  };
  const key = async (label, x, y, w, sub) => {
    const slot = await UI.createElement(win, { item: { position: { x, y }, size: { x: w, y: metrics.keyHeight } } });
    await UI.attach(win, keys, slot);
    const character = !MODIFIERS.has(label) && label !== ENTER && label !== SPACE_KEY && mode === 'password';
    const caption = label === ENTER ? options.enterLabel || ENTER : label === SPACE_KEY ? 'space' : shifted && character ? label.toUpperCase() : label;
    let labelId;
    const id = await button(win, slot, caption, w, metrics.keyHeight, () => press(label), {
      colour: keyColour(label), radius: RADIUS.control, gap: 0,
      labelColour: label === ENTER ? INK : label === SPACE_KEY ? MUTED : CREAM,
      font: label === ENTER || MODIFIERS.has(label) ? FONT_STRONG : FONT,
      size: mode !== 'password' ? (sub !== undefined && label !== BACKSPACE && label !== ENTER ? 26 : 20) : label === SPACE_KEY ? TYPE.caption : MODIFIERS.has(label) || label === ENTER ? TYPE.caption + 1 : 21,
      labelHeight: sub ? metrics.keyHeight - 14 : metrics.keyHeight,
      pressScale: 0.92, releaseScale: 1.04,
      onLabel: id => { labelId = id; },
      onPress: () => {
        if (!input.enabled) return;
        if (character) showBubble(shifted ? label.toUpperCase() : label, x, y, w).catch(() => {});
        if (label === BACKSPACE) {
          // Delete on touch, then repeat while held.
          input.focus(); backspace();
          stopRepeat();
          const tick = delay => { repeat = setTimeout(() => { if (!input.enabled) return stopRepeat(); backspace(); tick(70); }, delay); };
          tick(420);
        }
      },
      onRelease: () => { stopRepeat(); if (character) setTimeout(hideBubble, 70); }
    });
    if (sub) await text(win, id, sub, 11, w, 14, MUTED);
    if (character) letterLabels.push({ id: labelId, label });
    if (label === SHIFT) shiftLabel = labelId;
    await UI.setElementId(win, id, 'key-' + (label === ENTER ? 'enter' : label === BACKSPACE ? 'backspace' : label === SHIFT ? 'shift' : label === SPACE_KEY ? 'space' : label));
  };
  const drawKeys = async () => {
    if (keys) await UI.destroyElement(win, keys);
    letterLabels = []; shiftLabel = undefined;
    keys = await UI.createElement(win, { item: { size: { x: trayWidth, y: trayHeight } } });
    await UI.attach(win, tray, keys);
    const rowY = r => metrics.top + r * (metrics.keyHeight + metrics.rowGap);
    if (mode !== 'password') {
      // Phone keypad, centred and capped so wide screens keep it compact.
      const padWidth = Math.min(trayWidth - 2 * metrics.side, 3 * 150);
      const w = (padWidth - 2 * metrics.keyGap) / 3, left = (trayWidth - padWidth) / 2;
      // Letters under the digits only where the keys are tall enough for both.
      const captions = metrics.keyHeight >= 44;
      for (const [i, [label, sub]] of PIN.entries()) {
        await key(label, left + (i % 3) * (w + metrics.keyGap), rowY(Math.floor(i / 3)), w, captions ? sub : '');
      }
    } else {
      const rows = rowsOf(layout === 'letters' ? LETTERS : layout === 'symbols' ? SYMBOLS : MORE);
      for (const [r, row] of rows.entries()) {
        let x = metrics.side;
        for (const [label, units] of row) {
          const w = units * unit + (Math.ceil(units) - 1) * metrics.keyGap;
          if (label) await key(label, x, rowY(r), w);
          x += w + metrics.keyGap;
        }
      }
    }
    // The bubble is drawn last so it sits above every key.
    bubble = await UI.createElement(win, { renderable: { type: 'box', colour: BUBBLE, cornerRadius: RADIUS.surface, cornerResolution: 16, origin: { x: 0.5, y: 1 } },
      item: { position: { x: 0, y: 0 }, size: { x: 44, y: metrics.keyHeight * 1.3 } }, contentAlign: 'fill', inheritAnimation: true });
    await UI.attach(win, keys, bubble);
    await UI.setHitTarget(win, bubble, false);
    bubbleText = await text(win, bubble, '', 30, 'auto', 'auto', CREAM);
    bubbleMotion = await clips(win, bubble, { pop: [
      { time: 0, scale: { x: 0.6, y: 0.6 }, opacity: 0.4 },
      { time: 0.08, scale: { x: 1.06, y: 1.06 }, opacity: 1, ease: 'outCubic' },
      { time: 0.16, scale: { x: 1, y: 1 }, opacity: 1, ease: 'inOutQuad' }] });
    await UI.setEnabled(win, bubble, false);
    await UI.setEnabled(win, keys, keyboardShown && input.enabled);
  };

  const input = {
    win, root, entry, tray, focused: false, enabled: true, keyboardHeight: trayHeight,
    get value() { return value; }, get mode() { return mode; },
    focus() {
      if (!input.enabled) return;
      for (const other of fields) if (other.win === win) other.focused = false;
      input.focused = true; enqueue(paint);
    },
    insert: event => insert(String(event.text || '')),
    key(event) {
      if ([14, 65288].includes(event.key)) backspace();
      else if ([28, 96, 65293].includes(event.key)) submit();
      else if ([1, 65307].includes(event.key)) options.onCancel?.();
    },
    answer: () => credentialAnswer(value, mode, options.profile || {}, Credentials.derivePin),
    clear() { value = ''; update(); },
    setValue(next) { value = cleanCredential(next); update(); },
    // A wrong answer: the field shakes and empties.
    reject() { value = ''; update(); return fieldMotion.play('shake'); },
    async setEnabled(enabled) {
      const wasEnabled = input.enabled; input.enabled = enabled;
      stopRepeat();
      if (!enabled) { input.focused = false; value = ''; hideBubble(); }
      else if (!wasEnabled && options.focus !== false) input.focus();
      await paint();
      if (keys) await UI.setEnabled(win, keys, enabled && keyboardShown);
      // While checking, the tray dips instead of vanishing.
      if (wasEnabled !== enabled) await trayMotion.play(enabled ? 'show' : 'hide');
    },
    dispose() {
      disposed = true; value = ''; input.focused = false; input.enabled = false; stopRepeat(); fields.delete(input);
      // A docked tray slides off the bottom edge before it is removed.
      if (docked) trayMotion.play('leave').catch(() => {}).finally(() => setTimeout(() => UI.destroyElement(win, tray).catch(() => {}), 220));
    }
  };
  fields.add(input);

  if (hasSelector) {
    const selector = await UI.createElement(win, { renderable: { type: 'box', colour: alpha(CARD, 0.85), cornerRadius: RADIUS.control, cornerResolution: 16 },
      item: { size: { x: entryWidth, y: SELECTOR } }, contentAlign: 'fill' });
    await UI.attach(win, entryHost, selector);
    highlight = await UI.createElement(win, { renderable: { type: 'box', colour: TONAL, cornerRadius: RADIUS.control - 1, cornerResolution: 16 },
      item: { position: { x: 0, y: 2 }, size: { x: segmentWidth, y: SELECTOR - 4 } }, contentAlign: 'fill' });
    await UI.attach(win, selector, highlight);
    await UI.setHitTarget(win, highlight, false);
    const glide = await UI.addAnimation(win, highlight, [{ time: 0.22, position: { x: 2, y: 0 }, ease: 'outCubic' }]);
    segments = { play: async (kind, x) => {
      await UI.updateAnimation(win, highlight, glide, kind === 'move'
        ? [{ time: 0.1, position: { x: x + (x > 2 ? 6 : -6), y: 0 }, scale: { x: 1.04, y: 1 }, ease: 'outCubic' }, { time: 0.24, position: { x, y: 0 }, scale: { x: 1, y: 1 }, ease: 'inOutQuad' }]
        : [{ time: 0, position: { x, y: 0 } }]);
      await UI.startAnimation(win, highlight, glide);
    } };
    const labels = [];
    for (const [i, choice] of choices.entries()) {
      const slot = await UI.createElement(win, { item: { position: { x: 2 + i * segmentWidth, y: 0 }, size: { x: segmentWidth, y: SELECTOR } } });
      await UI.attach(win, selector, slot);
      await button(win, slot, choice === 'pin' ? 'PIN' : choice === 'pin-pending' ? 'New PIN' : 'Password', segmentWidth, SELECTOR, () => {
        if (!input.enabled || choice === mode) return;
        mode = choice; value = ''; shifted = false; layout = 'letters';
        enqueue(async () => {
          for (const [j, id] of labels.entries()) await UI.setTextColour(win, id, choices[j] === mode ? ORANGE : MUTED);
          await segments.play('move', 2 + choices.indexOf(mode) * segmentWidth);
          await paint(); await drawKeys();
        });
      }, { colour: CLEAR, size: TYPE.caption, font: FONT_STRONG, labelColour: choice === mode ? ORANGE : MUTED, labelHeight: SELECTOR,
        onLabel: id => labels.push(id) });
    }
    await segments.play('place', 2 + choices.indexOf(mode) * segmentWidth);
  }
  await paint(); await drawKeys();
  if (docked) await trayMotion.play('enter');
  if (options.focus !== false) input.focus();
  return input;
}

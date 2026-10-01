import * as UI from 'Helix/UserInterface';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import * as Credentials from 'Module/credentials';
import { button, label, text } from './touch-ui.js';
import { CREAM, ORANGE, INK, CARD, TONAL, MUTED, SPACE, RADIUS, TYPE } from './theme.js';
import { cleanCredential, credentialAnswer, pinSalt } from './credential-model.js';

const fields = new Set();
const dispatch = (event, kind) => {
  for (const field of fields) if (field.win === event.id && field.focused && field.enabled) field[kind](event);
};
Event.on('textInput', event => dispatch(event, 'insert'));
Event.on('textRepeat', event => dispatch(event, 'insert'));
Event.on('keyDown', event => dispatch(event, 'key'));
Event.on('keyRepeat', event => { if ([14, 65288].includes(event.key)) dispatch(event, 'key'); });

export async function credentialInput(win, parent, options) {
  let value = cleanCredential(options.value), mode = options.mode || 'password', shifted = false, symbols = false;
  let keyboard, selector, field, width = options.width, keyboardShown = options.keyboard !== false;
  const compact = !!options.compact;
  let entryWidth = compact ? Math.min(240, Math.round(width * 0.28)) : width;
  let keyboardWidth = compact ? width - entryWidth - SPACE.m : width;
  const rowHeight = options.rowHeight || 48, gap = SPACE.xs;
  let queue = Promise.resolve(), disposed = false;
  const enqueue = job => queue = queue.then(() => !disposed && job()).catch(() => Log.error('Credential input could not update'));
  const hasSelector = !options.echo && options.allowMode !== false && !!pinSalt(options.profile || {});
  const entryHeight = 56 + (hasSelector ? SPACE.s + 36 : 0);
  const keyboardHeight = () => (mode === 'password' && symbols ? 5 : 4) * rowHeight + (mode === 'password' && symbols ? 4 : 3) * gap;
  const totalHeight = () => compact ? Math.max(entryHeight, keyboardHeight()) : entryHeight + SPACE.s + keyboardHeight();
  const root = await UI.createElement(win, { layout: { type: compact ? 'row' : 'column', gap: compact ? SPACE.m : SPACE.s }, item: { size: { x: width, y: totalHeight() } } });
  await UI.attach(win, parent, root);
  const entryHost = compact ? await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: entryWidth, y: entryHeight } } }) : root;
  if (compact) await UI.attach(win, root, entryHost);
  const entry = await UI.createElement(win, { renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.control, cornerResolution: 16 },
    layout: { type: 'column', padding: { l: SPACE.m, r: SPACE.m, t: 0, b: 0 } }, item: { size: { x: entryWidth, y: 56 } }, contentAlign: 'fill',
    onMouseDown: () => input.focus() });
  await UI.attach(win, entryHost, entry);
  await UI.setElementId(win, entry, options.id || 'credential-response');
  field = await label(win, entry, '', TYPE.body + 2, entryWidth - 2 * SPACE.m, 56);
  await UI.setHitTarget(win, field, false);
  const paint = async () => {
    const shown = value ? options.echo ? value : '•'.repeat(Array.from(value).length) : mode !== 'password' ? 'Enter PIN' : options.placeholder || 'Enter password';
    await UI.setTextString(win, field, shown);
    await UI.setTextColour(win, field, value ? CREAM : MUTED);
  };
  const update = () => { enqueue(paint); options.onChange?.(value); };
  const submit = () => input.enabled && options.onSubmit?.();
  const backspace = () => { value = Array.from(value).slice(0, -1).join(''); update(); };
  const insert = text => {
    if (!input.enabled) return;
    if (/[\r\n]/.test(text)) { submit(); return; }
    text = cleanCredential(text);
    if (mode !== 'password') text = text.replace(/\D/g, '');
    value = (value + text).slice(0, mode !== 'password' ? 12 : 512); update();
  };
  const drawKeyboard = async () => {
    if (keyboard) await UI.destroyElement(win, keyboard);
    await UI.setLayoutSize(win, root, { x: width, y: totalHeight() });
    keyboard = await UI.createElement(win, { layout: { type: 'column', gap }, item: { size: { x: keyboardWidth, y: keyboardHeight() } } });
    await UI.attach(win, root, keyboard);
    await UI.setEnabled(win, keyboard, keyboardShown && input.enabled);
    const rows = mode !== 'password' ? ['123', '456', '789', ['⌫', '0', '↵']]
      : symbols ? ['1234567890', '!@#$%^&*()', '-_=+[]{}\\|', ';:\'",.<>/?', ['ABC', 'Space', '⌫', '↵']]
      : ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', ['⇧', '123', 'Space', '⌫', '↵']];
    for (const row of rows) {
      const keys = Array.isArray(row) ? row : Array.from(shifted && !symbols ? row.toUpperCase() : row);
      const element = await UI.createElement(win, { layout: { type: 'row', gap }, item: { size: { x: keyboardWidth, y: rowHeight } } });
      await UI.attach(win, keyboard, element);
      const keyWidth = (keyboardWidth - gap * (keys.length - 1)) / keys.length;
      for (const key of keys) await button(win, element, key, keyWidth, rowHeight, () => {
        if (!input.enabled) return;
        input.focus();
        if (key === '⌫') backspace();
        else if (key === '↵') submit();
        else if (key === '⇧') { shifted = !shifted; enqueue(drawKeyboard); }
        else if (key === '123' || key === 'ABC') { symbols = !symbols; enqueue(drawKeyboard); }
        else insert(key === 'Space' ? ' ' : key);
      }, { colour: key === '↵' ? ORANGE : TONAL, labelColour: key === '↵' ? INK : CREAM, size: mode !== 'password' ? 24 : 18 });
    }
  };
  const input = {
    win, root, entry, focused: false, enabled: true,
    get value() { return value; }, get mode() { return mode; },
    focus() { if (!input.enabled) return; for (const other of fields) if (other.win === win) other.focused = false; input.focused = true; },
    insert: event => insert(String(event.text || '')),
    key(event) {
      if ([14, 65288].includes(event.key)) backspace();
      else if ([28, 96, 65293].includes(event.key)) submit();
      else if ([1, 65307].includes(event.key)) options.onCancel?.();
    },
    answer: () => credentialAnswer(value, mode, options.profile || {}, Credentials.derivePin),
    clear() { value = ''; update(); },
    setValue(next) { value = cleanCredential(next); update(); },
    async setEnabled(enabled) { const wasEnabled = input.enabled; input.enabled = enabled; if (!enabled) { input.focused = false; value = ''; } else if (!wasEnabled && options.focus !== false) input.focus(); await paint(); if (keyboard) await UI.setEnabled(win, keyboard, enabled && keyboardShown); },
    dispose() { disposed = true; value = ''; input.focused = false; input.enabled = false; fields.delete(input); }
  };
  fields.add(input);
  if (hasSelector) {
    selector = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.s }, item: { size: { x: entryWidth, y: 36 } } });
    await UI.attach(win, entryHost, selector);
    const choices = ['password', 'pin'];
    if (options.profile.AuthenticationMode === 'pin' && options.profile.PendingAuthenticationMode === 'pin' && options.profile.AuthenticationSalt !== options.profile.PendingAuthenticationSalt) choices.push('pin-pending');
    for (const choice of choices) await button(win, selector, choice === 'pin' ? 'PIN' : choice === 'pin-pending' ? 'New PIN' : 'Password', (entryWidth - SPACE.s * (choices.length - 1)) / choices.length, 36, () => {
      if (!input.enabled || choice === mode) return;
      mode = choice; value = ''; shifted = symbols = false; enqueue(async () => { await paint(); await drawKeyboard(); });
    }, { colour: TONAL, size: TYPE.caption });
  }
  await paint(); await drawKeyboard();
  if (options.focus !== false) input.focus();
  return input;
}

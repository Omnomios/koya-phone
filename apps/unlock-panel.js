import * as UI from 'Helix/UserInterface';
import { credentialInput, credentialKeyboardHeight } from './credential-input.js';
import { button, text } from './touch-ui.js';
import { FONT_STRONG, CREAM, ORANGE, INK, MUTED, CLEAR, GUTTER, SPACE, RADIUS, TYPE, TOUCH } from './theme.js';

// The lock screen's authentication panel. The keyboard docks to the bottom
// edge like a system keyboard; everything else stacks directly above it, so
// the field, its status and the keys stay within one thumb's reach.
// `root` must be a layout-less element covering the window.
export async function unlockPanel(win, root, size, options) {
  const landscape = size.x > size.y;
  const keyboard = credentialKeyboardHeight(size);
  const width = Math.min(landscape ? 520 : 420, size.x - 2 * GUTTER);
  const inset = Math.round((size.x - width) / 2);
  const body = await UI.createElement(win, { layout: { type: 'column', alignItems: 'center',
    padding: { l: GUTTER, r: GUTTER, t: SPACE.s, b: SPACE.m } }, item: { position: { x: 0, y: 0 }, size: { x: size.x, y: size.y - keyboard } } });
  await UI.attach(win, root, body);
  const full = size.x - 2 * GUTTER;

  // Cancel returns to the clock; it sits where back always sits.
  const top = await UI.createElement(win, { layout: { type: 'row', alignItems: 'center' }, item: { size: { x: full, y: TOUCH } } });
  await UI.attach(win, body, top);
  await button(win, top, 'Cancel', 96, TOUCH, options.onCancel, { colour: CLEAR, labelColour: MUTED, size: TYPE.body, radius: RADIUS.control });
  const grow = async () => { const id = await UI.createElement(win, { item: { size: { x: full, y: 0 }, flexGrow: 1 } }); await UI.attach(win, body, id); };

  let clock, date;
  if (!landscape) {
    await grow();
    clock = await text(win, body, options.time[0], 64, full, 76);
    date = await text(win, body, options.time[1], TYPE.caption + 1, full, 24, MUTED);
  } else {
    // No room for a large clock beside the keyboard; keep it small, top right.
    await UI.attach(win, top, await UI.createElement(win, { item: { size: { x: full - 96 - 140, y: TOUCH } } }));
    clock = await text(win, top, options.time[0], TYPE.heading, 140, TOUCH, CREAM, undefined, 'right');
  }
  await grow();

  // Who is unlocking: an initial on an orange disc, then the name.
  const name = options.user || 'Unlock';
  const identity = await UI.createElement(win, { layout: { type: landscape ? 'row' : 'column', alignItems: 'center', justifyContent: 'center', gap: landscape ? SPACE.m : SPACE.s },
    item: { size: { x: width, y: landscape ? 48 : 96 } } });
  await UI.attach(win, body, identity);
  const avatarSize = landscape ? 40 : 56;
  const avatar = await UI.createElement(win, { renderable: { type: 'circle', aabb: { min: { x: 0, y: 0 }, max: { x: avatarSize, y: avatarSize } }, resolution: 48, colour: ORANGE },
    item: { size: { x: avatarSize, y: avatarSize } }, contentAlign: 'fill' });
  await UI.attach(win, identity, avatar);
  await text(win, avatar, name.slice(0, 1).toUpperCase(), landscape ? 20 : 26, avatarSize, avatarSize, INK, FONT_STRONG);
  await text(win, identity, name, TYPE.heading, landscape ? Math.min(width - avatarSize - SPACE.m, 320) : width, 30, CREAM, undefined, landscape ? 'left' : 'center');
  await UI.attach(win, body, await UI.createElement(win, { item: { size: { x: full, y: landscape ? SPACE.s : SPACE.l } } }));

  const input = await credentialInput(win, body, { width, value: options.value, profile: options.profile, mode: options.mode,
    id: 'lock-credential', enterLabel: 'Unlock', dock: { parent: root, size }, onSubmit: options.onSubmit, onCancel: options.onCancel });
  const status = await text(win, body, options.message || '', TYPE.caption, width, 28, ORANGE);
  return { input, status, clock, date, keyboard, inset };
}

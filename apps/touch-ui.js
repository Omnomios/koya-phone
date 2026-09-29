import * as UI from 'Helix/UserInterface';
import { FONT, FONT_STRONG, CREAM, CLEAR, CARD, TONAL, TRACK, ORANGE, SHEET_TINT, RADIUS, TYPE, HEADER_HEIGHT, TOUCH } from './theme.js';
import { clips } from './motion.js';
import { haptic } from './haptics.js';
import { wallpaperSurface } from './wallpaper-surface.js';

// contentAlign places the text's bounds in its slot. With the default 'ink'
// basis those bounds are the tight glyph box, which changes with every string
// (ascenders, descenders, width), so labels jump when their text changes.
// 'line' uses the font's stable line box instead. contentAlign 'fill' is not
// used: only box renderables resize to fill a slot.
export async function text(win, parent, value, size, width, height, colour = CREAM, font = FONT, justify = 'center') {
  const align = { left: 'start', center: 'center', right: 'end' }[justify];
  const id = await UI.createElement(win, {
    renderable: { type: 'text', string: value, size, font, colour, justify, vAlign: 'center', metricsBasis: 'line' },
    item: { size: { x: width, y: height } }, contentAlign: { x: align, y: 'center' }
  });
  await UI.attach(win, parent, id);
  return id;
}

// Start-aligned, clipped and word-wrapped: row titles, captions and body copy.
// Word-wrap needs an explicit reflow box; the slot size alone does not set it.
export async function label(win, parent, value, size, width, height, colour = CREAM, font = FONT) {
  const id = await UI.createElement(win, {
    renderable: { type: 'text', string: value, size, font, colour, layoutMode: 'word-wrap', justify: 'left', vAlign: 'center',
      metricsBasis: 'line', aabb: { min: { x: 0, y: 0 }, max: { x: width, y: height } } },
    item: { size: { x: width, y: height } }, contentAlign: { x: 'start', y: 'center' }, clipToBounds: true
  });
  await UI.attach(win, parent, id);
  return id;
}

export async function icon(win, parent, texture, size, width = size, height = size) {
  const id = await UI.createElement(win, {
    renderable: { type: 'sprite', texture, frame: 0,
      frames: [{ size: { x: size, y: size }, aabb: { min: { x: 0, y: 0 }, max: { x: 160, y: 160 } }, colour: [1,1,1,1] }] },
    item: { size: { x: width, y: height } }, contentAlign: { x: 'center', y: 'center' }
  });
  await UI.attach(win, parent, id);
  return id;
}

export async function button(win, parent, label, width, height, handler, options = {}) {
  let motion;
  let waiting = false;
  const id = await UI.createElement(win, {
    renderable: { ...(options.renderable || { type: 'box', colour: options.colour || [0,0,0,0], cornerRadius: options.radius ?? RADIUS.control, cornerResolution: 32 }),
      origin: { x: 0.5, y: 0.5 } },
    layout: { type: 'column', justifyContent: 'center', alignItems: 'center', gap: options.gap ?? 8 },
    item: { size: { x: width, y: height } }, contentAlign: 'fill', inheritAnimation: true,
    onMouseDown: () => { haptic(); if (!waiting) motion?.play('press'); },
    onMouseUp: () => !waiting && motion?.play('release'),
    onMouseExit: () => !waiting && motion?.play('settle'),
    onMouseClick: handler
  });
  await UI.attach(win, parent, id);
  const pose = scale => ({ scale: { x: scale, y: scale } });
  const bounce = options.feedbackMotion || { squash: 0.95, peak: 1.04, lift: 3 };
  motion = await clips(win, id, {
    press: [{ time: 0.07, ...pose(options.pressScale ?? 0.95), ease: 'outQuad' }],
    release: [{ time: 0.09, ...pose(options.releaseScale ?? 1.02), ease: 'outCubic' }, { time: 0.23, ...pose(1), ease: 'outCubic' }],
    settle: [{ time: 0.14, ...pose(1), position: { x: 0, y: 0 }, ease: 'outCubic' }],
    ...(options.onFeedback ? { waiting: [
      { time: 0, ...pose(1), position: { x: 0, y: 0 } },
      { time: 0.08, ...pose(bounce.squash), position: { x: 0, y: 2 }, ease: 'outQuad' },
      { time: 0.23, ...pose(bounce.peak), position: { x: 0, y: -bounce.lift }, ease: 'outCubic' },
      { time: 0.54, ...pose(1), position: { x: 0, y: 0 }, ease: 'outCubic' },
      { time: 0.68, ...pose(1), position: { x: 0, y: 0 }, looping: true }
    ] } : {})
  });
  options.onFeedback?.({
    begin: () => { waiting = true; return motion.play('waiting'); },
    end: () => { waiting = false; return motion.play('settle'); }
  });
  if (options.icon) {
    const glyph = await icon(win, id, options.icon, options.iconSize || 72, width, options.iconSize || 72);
    options.onIcon?.(glyph);
  }
  // Full width: the column does not centre narrower children across its axis.
  if (label) await text(win, id, label, options.size || 19, width, options.labelHeight || 32, options.labelColour || options.accent || CREAM, options.font);
  return id;
}

// Full-screen sheets show the wallpaper dimmed underneath. `offset` aligns the
// sprite with the real wallpaper when the sheet window starts below the top bar.
export async function backdrop(win, parent, size, offset = 0) {
  const id = await wallpaperSurface(win, { x: size.x, y: size.y + offset }, SHEET_TINT);
  await UI.attach(win, parent, id);
  if (offset) await UI.setPosition(win, id, { x: 0, y: -offset });
  return id;
}

// Every sheet starts with the same header: a title on the left and square
// icon actions on the right, so close buttons land in the same place.
export async function sheetHeader(win, parent, title, width, actions = [], accessory) {
  const row = await UI.createElement(win, {
    layout: { type: 'row', alignItems: 'center' }, item: { size: { x: width, y: HEADER_HEIGHT } }
  });
  await UI.attach(win, parent, row);
  const reserved = actions.reduce((sum, action) => sum + (action.width || TOUCH), 0) + (accessory?.width || 0);
  const heading = await label(win, row, title, TYPE.title, width - reserved, HEADER_HEIGHT);
  if (accessory) await accessory.build(row);
  const buttons = [];
  for (const action of actions) {
    buttons.push(action.build ? await action.build(row)
      : await button(win, row, '', action.width || TOUCH, HEADER_HEIGHT, action.handler,
        { colour: CLEAR, icon: action.icon, iconSize: action.iconSize || 22 }));
  }
  return { row, heading, buttons };
}

// A full-width tappable row (settings tiles, list entries) with the same
// press response as buttons. Children are laid out left to right.
// onPress/onRelease let callers add secondary motion (a chevron nudge).
export async function row(win, parent, width, height, handler, options = {}) {
  let motion;
  const id = await UI.createElement(win, {
    renderable: { type: 'box', colour: options.colour || CARD, cornerRadius: options.radius ?? RADIUS.surface, cornerResolution: 16, origin: { x: 0.5, y: 0.5 } },
    layout: { type: 'row', alignItems: 'center', gap: options.gap ?? 12, padding: { l: 16, r: options.right ?? 12, t: 0, b: 0 } },
    item: { size: { x: width, y: height } }, contentAlign: 'fill', inheritAnimation: true,
    onMouseDown: () => { haptic(); motion?.play('press'); options.onPress?.(); },
    onMouseUp: () => { motion?.play('release'); options.onRelease?.(); },
    onMouseExit: () => { motion?.play('release'); options.onRelease?.(); },
    onMouseClick: handler
  });
  await UI.attach(win, parent, id);
  // Press frames also restore opacity and offset, so tapping a row during its
  // entrance cannot leave it half-faded or displaced.
  const rest = { opacity: 1, position: { x: 0, y: 0 } };
  motion = await clips(win, id, {
    press: [{ time: 0.07, ...rest, scale: { x: 0.97, y: 0.97 }, ease: 'outQuad' }],
    release: [{ time: 0.11, ...rest, scale: { x: 1.012, y: 1.012 }, ease: 'outCubic' }, { time: 0.26, ...rest, scale: { x: 1, y: 1 }, ease: 'inOutQuad' }]
  });
  return id;
}

// Secondary actions: a quiet filled pill that reads as tappable without
// competing with the content around it.
export function pill(win, parent, value, width, handler, options = {}) {
  const height = options.height || TOUCH;
  // Semibold labels hold up against the tonal fill at caption size.
  return button(win, parent, value, width, height, handler, {
    colour: options.colour || TONAL, radius: RADIUS.control, size: options.size || TYPE.caption + 1,
    labelHeight: height, labelColour: options.labelColour || CREAM, font: FONT_STRONG, ...options
  });
}

// On/off switch. Returns a setter so callers can reflect external state.
// The knob stretches as it leaves, overshoots its stop and settles; the whole
// switch squashes under the finger.
export async function toggle(win, parent, on, handler) {
  const width = 52, height = 32, knob = 24, inset = (height - knob) / 2;
  let pop;
  const target = await UI.createElement(win, {
    // Invisible box: a bare container ignores its pivot when scaled.
    renderable: { type: 'box', colour: CLEAR, origin: { x: 0.5, y: 0.5 } },
    layout: { type: 'column', justifyContent: 'center', alignItems: 'center' },
    item: { size: { x: width + 16, y: TOUCH } }, contentAlign: 'fill', inheritAnimation: true,
    onMouseDown: () => { haptic(); pop?.play('press'); },
    onMouseUp: () => pop?.play('release'),
    onMouseExit: () => pop?.play('release'),
    onMouseClick: handler
  });
  await UI.attach(win, parent, target);
  pop = await clips(win, target, {
    press: [{ time: 0.06, scale: { x: 0.88, y: 0.88 }, ease: 'outQuad' }],
    release: [{ time: 0.16, scale: { x: 1.08, y: 1.08 }, ease: 'outCubic' }, { time: 0.3, scale: { x: 1, y: 1 }, ease: 'inOutQuad' }]
  });
  const track = await UI.createElement(win, {
    // The one fully round control: a switch reads as a switch by its shape.
    renderable: { type: 'box', colour: on ? ORANGE : TRACK, cornerRadius: height / 2, cornerResolution: 32 },
    // Explicit inset on all sides: row centring does not place the knob.
    layout: { type: 'row', padding: { l: inset, r: inset, t: inset, b: inset } },
    item: { size: { x: width, y: height } }, contentAlign: 'fill'
  });
  await UI.attach(win, target, track);
  const thumb = await UI.createElement(win, {
    renderable: { type: 'box', colour: CREAM, cornerRadius: knob / 2, cornerResolution: 32, origin: { x: 0.5, y: 0.5 } },
    item: { size: { x: knob, y: knob } }, contentAlign: 'fill'
  });
  await UI.attach(win, track, thumb);
  const travel = width - 2 * inset - knob;
  const stretch = { x: 1.3, y: 0.8 }, round = { x: 1, y: 1 };
  const motion = await clips(win, thumb, {
    on: [{ time: 0.1, position: { x: travel + 3, y: 0 }, scale: stretch, ease: 'outCubic' },
      { time: 0.26, position: { x: travel, y: 0 }, scale: round, ease: 'outQuad' }],
    off: [{ time: 0.1, position: { x: -3, y: 0 }, scale: stretch, ease: 'outCubic' },
      { time: 0.26, position: { x: 0, y: 0 }, scale: round, ease: 'outQuad' }]
  });
  let current = on;
  if (on) await UI.setPosition(win, thumb, { x: travel, y: 0 });
  const set = async value => {
    if (value === current) return;
    current = value;
    await Promise.all([UI.setBoxColour(win, track, value ? ORANGE : TRACK), motion.play(value ? 'on' : 'off')]);
  };
  return { id: target, set };
}

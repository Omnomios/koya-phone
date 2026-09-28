import * as UI from 'Helix/UserInterface';
import { FONT, CREAM } from './theme.js';
import { clips } from './motion.js';
import { haptic } from './haptics.js';

export async function text(win, parent, value, size, width, height, colour = CREAM) {
  const id = await UI.createElement(win, {
    renderable: { type: 'text', string: value, size, font: FONT, colour },
    item: { size: { x: width, y: height } }, contentAlign: { x: 'center', y: 'center' }
  });
  await UI.attach(win, parent, id);
  await UI.setTextVerticalAlign(win, id, 'center');
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
    renderable: { ...(options.renderable || { type: 'box', colour: options.colour || [0,0,0,0], cornerRadius: options.radius ?? 14 }),
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
  if (label) await text(win, id, label, options.size || 19, width - 12, options.labelHeight || 32, options.labelColour || options.accent || CREAM);
  return id;
}

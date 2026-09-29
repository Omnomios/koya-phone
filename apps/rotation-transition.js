import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import { INK } from './theme.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fade = async (win, element, frames) => {
  const clip = await UI.addAnimation(win, element, frames);
  let finish, timeout;
  const ended = new Promise((resolve, reject) => {
    finish = resolve;
    timeout = setTimeout(() => reject(new Error('Rotation fade timed out')), 2000);
  });
  try {
    await UI.onAnimationEnd(win, element, clip, finish);
    await UI.startAnimation(win, element, clip);
    await ended;
  } finally { clearTimeout(timeout); }
};

// Cover asynchronous client relayouts with a short fade. The shade itself uses
// automatic layout, so its first resized buffer already covers the new output.
export const rotationTransition = display => async apply => {
  const win = await Compositor.createWindow({ role: 'overlay', anchor: 'fill', display: display.display,
    size: { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) },
    namespace: 'koya-rotation-transition', exclusiveZone: -1, transparent: true,
    msaaSamples: 1, keyboardInteractivity: 'none', acceptPointerEvents: false });
  try {
    await Compositor.setWindowRenderingEnabled(win, false);
    const shade = await UI.createElement(win, { renderable: { type: 'box', colour: INK },
      item: { size: { x: 'auto', y: 'auto' } }, contentAlign: 'fill' });
    await UI.attachRoot(win, shade);
    const hidden = await UI.addAnimation(win, shade, [{ time: 0, opacity: 0 }]);
    await UI.startAnimation(win, shade, hidden);
    await Compositor.setWindowRenderingEnabled(win, true);
    await fade(win, shade, [{ time: 0, opacity: 0 }, { time: 0.12, opacity: 1, ease: 'inOutQuad' }]);
    await pause(34); // Let the final opaque frame reach the compositor.
    if (await apply()) await pause(300);
    await fade(win, shade, [{ time: 0, opacity: 1 }, { time: 0.18, opacity: 0, ease: 'outCubic' }]);
  } finally { await Compositor.destroyWindow(win); }
};

import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { connect, call } from './session.js';
import { clips } from './motion.js';
import { wallpaperSurface } from './wallpaper-surface.js';
import { lockMotion } from './lock-motion.js';
import { swipeGesture } from './swipe.js';
import { text as textElement } from './touch-ui.js';
import { CREAM, ORANGE, MUTED, TYPE, SPACE } from './theme.js';

// Visual prototype, not a security boundary. Display power belongs to the coordinator.
export default async () => {
  const display = (await Compositor.listDisplays())[0];
  if (!display) throw new Error('No display available');
  const win = await Compositor.createWindow({
    role: 'overlay', anchor: 'top-left', display: display.display,
    size: { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) },
    exclusiveZone: -1, namespace: 'koya-lock-screen', msaaSamples: 1,
    transparent: true, keyboardInteractivity: 'exclusive', acceptPointerEvents: true
  });
  const info = await Compositor.getWindowInfo(win);
  if (info.role !== 'overlay') throw new Error('Lock screen requires layer-shell');
  await Compositor.setWindowRenderingEnabled(win, false);
  await Compositor.setClearColor(win, 0, 0, 0, 0);
  const size = { x: info.width, y: info.height };
  const root = await UI.createElement(win, {
    renderable: { type: 'box', colour: [0, 0, 0, 1] }, item: { size }, contentAlign: 'fill'
  });
  await UI.attachRoot(win, root);
  const sheet = await wallpaperSurface(win, size, [0.45, 0.50, 0.43, 1]);
  await UI.attach(win, root, sheet);
  await UI.setElementId(win, sheet, 'lock-sheet');
  // Clock in the upper third, where the eye lands; the unlock hint sits at
  // the bottom edge, where the swipe starts.
  const content = await UI.createElement(win, {
    layout: { type: 'column', padding: { l: 0, r: 0, t: Math.round(info.height * 0.16), b: Math.max(40, Math.round(info.height * 0.05)) } }, item: { size }
  });
  // Wallpaper and text are siblings: only the text follows the swipe.
  await UI.attach(win, root, content);
  await UI.setInheritAnimation(win, content, true);
  await UI.setElementId(win, content, 'lock-content');
  const text = (value, fontSize, height, colour = CREAM) => textElement(win, content, value, fontSize, info.width, height, colour);
  const format = () => {
    const now = new Date();
    return [String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
      ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()] + ', ' + now.getDate() + ' ' +
      ['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()]];
  };
  let displayed = format();
  const clock = await text(displayed[0], Math.min(TYPE.display, info.width * 0.2), Math.min(TYPE.display, info.width * 0.2) * 1.2);
  const date = await text(displayed[1], Math.min(TYPE.heading, info.width * 0.05), 32);
  await UI.attach(win, content, await UI.createElement(win, { item: { flexGrow: 1 } }));
  const arrow = await text('↑', 30, 40, ORANGE);
  await text('Swipe up to unlock', TYPE.caption + 1, 28, MUTED);
  // A few upward nudges teach the gesture, then stop: no idle animation.
  const nudge = await clips(win, arrow, {
    hint: [
      { time: 0.2, position: { x: 0, y: 0 } },
      { time: 0.34, position: { x: 0, y: -SPACE.s }, ease: 'outQuad' },
      { time: 0.52, position: { x: 0, y: 0 }, ease: 'inOutQuad' },
      { time: 0.66, position: { x: 0, y: -SPACE.s }, ease: 'outQuad' },
      { time: 0.84, position: { x: 0, y: 0 }, ease: 'inOutQuad' }
    ]
  });
  const hint = () => nudge.play('hint').catch(error => Log.error('Lock hint: ' + error));
  const motion = await lockMotion(win, sheet, content, size);
  const exit = await clips(win, root, {
    leave: [{ time: 0.25, opacity: 0, ease: 'outCubic' }],
    restore: [{ time: 0.15, opacity: 1, ease: 'outCubic' }]
  });
  let state, leaving = false, sent = false, fallback;
  const gesture = swipeGesture(info.height);
  // Serialize native changes; input/state decisions remain synchronous.
  let queue = Promise.resolve();
  const enqueue = fn => { queue = queue.then(fn).catch(error => Log.error('Lock screen: ' + error)); };
  const finish = async () => {
    if (!leaving || sent || state !== 'locked') return;
    sent = true;
    clearTimeout(fallback);
    try { await call('Unlock'); }
    catch (error) {
      sent = leaving = false;
      await exit.play('restore');
      await motion.play('settle');
      Log.error('Unlock: ' + error);
    }
  };
  await exit.onEnd('leave', finish);
  let dragDistance = null, dragQueued = false;
  const cancel = () => {
    dragDistance = null;
    gesture.cancel();
    if (state === 'locked' && !leaving) enqueue(() => motion.play('settle'));
  };
  await UI.setOnMouseDown(win, root, point => {
    if (state === 'locked' && !leaving) gesture.down({ x: point.x, y: point.y });
  });
  await UI.setOnMouseMove(win, root, point => {
    if (state !== 'locked' || leaving) return;
    const distance = gesture.move(point);
    if (distance === null) return;
    dragDistance = Math.min(info.height * 0.6, distance);
    if (dragQueued) return;
    dragQueued = true;
    enqueue(async () => {
      try {
        while (dragDistance !== null && state === 'locked' && !leaving) {
          const latest = dragDistance;
          dragDistance = null;
          await motion.drag(latest);
        }
      } finally { dragQueued = false; }
    });
  });
  await UI.setOnMouseUp(win, root, point => {
    if (state !== 'locked' || leaving) return;
    const distance = gesture.move(point);
    if (!gesture.up(point)) { cancel(); hint(); return; }
    leaving = true;
    fallback = setTimeout(finish, 700);
    enqueue(async () => {
      await motion.leave(distance);
      await exit.play('leave');
    });
  });
  await UI.setOnMouseExit(win, root, cancel);
  await motion.play('blank');
  await Compositor.setWindowRenderingEnabled(win, true);
  connect('lock-screen', next => {
    if (next.ScreenState === state) return;
    state = next.ScreenState;
    if (state === 'unlocked') return; // Preserve the completed exit until reaped.
    dragDistance = null;
    gesture.cancel();
    leaving = sent = false;
    clearTimeout(fallback);
    enqueue(async () => {
      await exit.play('restore');
      await motion.play('enter');
      hint();
    });
  });
  const refresh = async () => {
    try {
      const value = format();
      if (value[0] !== displayed[0]) await UI.setTextString(win, clock, value[0]);
      if (value[1] !== displayed[1]) await UI.setTextString(win, date, value[1]);
      displayed = value;
    } catch (error) { Log.error('Lock clock: ' + error); }
    setTimeout(refresh, 60000 - Date.now() % 60000);
  };
  setTimeout(refresh, 60000 - Date.now() % 60000);
  return win;
};

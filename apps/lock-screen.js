import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { connect, call } from './session.js';
import { clips } from './motion.js';
import { lockMotion } from './lock-motion.js';
import { swipeGesture } from './swipe.js';

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
  const sheet = await UI.createElement(win, {
    renderable: { type: 'sprite', texture: '/rom/assets/earthy-green-wallpaper.png', frame: 0,
      frames: [{ size, origin: { x: 0, y: 0 }, aabb: { min: { x: 0, y: 0 }, max: { x: 864, y: 1821 } }, colour: [0.45, 0.50, 0.43, 1] }] },
    item: { size }, contentAlign: 'fill'
  });
  await UI.attach(win, root, sheet);
  await UI.setElementId(win, sheet, 'lock-sheet');
  const content = await UI.createElement(win, {
    layout: { type: 'column', justifyContent: 'center', gap: 12 }, item: { size }
  });
  // Wallpaper and text are siblings: only the text follows the swipe.
  await UI.attach(win, root, content);
  await UI.setInheritAnimation(win, content, true);
  await UI.setElementId(win, content, 'lock-content');
  const text = async (value, fontSize, height, colour = [244/255, 233/255, 216/255, 1]) => {
    const element = await UI.createElement(win, {
      renderable: { type: 'text', string: value, size: fontSize, font: '/rom/fonts/SourceSans3-Regular.ttf', colour },
      item: { size: { x: info.width, y: height } }, contentAlign: { x: 'center', y: 'center' }
    });
    await UI.attach(win, content, element);
    await UI.setTextVerticalAlign(win, element, 'center');
    return element;
  };
  const format = () => {
    const now = new Date();
    return [String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
      ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()] + ', ' + now.getDate() + ' ' +
      ['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()]];
  };
  let displayed = format();
  const clock = await text(displayed[0], Math.min(72, info.width * 0.20), 90);
  const date = await text(displayed[1], Math.min(17, info.width * 0.045), 30);
  const spacer = await UI.createElement(win, { item: { size: { x: 1, y: Math.max(10, info.height * 0.25) } } });
  await UI.attach(win, content, spacer);
  await text('↑', 36, 45, [217/255,106/255,29/255,1]);
  await text('Swipe up to unlock', 16, 32);
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
    if (!gesture.up(point)) { cancel(); return; }
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

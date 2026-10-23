import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { pressFeedback } from '../apps/press-feedback.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const event = (phase, interactionId = 'touch:one', local = { x: 100, y: 36 }) => ({
  kind: 'press', phase, interactionId, pointerIds: [interactionId],
  source: 'touch', button: 'primary', windowId: 1, inside: true,
  local, position: { x: local.x + 1000, y: local.y + 500 }
});

// Release and cancellation belong to the interaction that actually started.
{
  const calls = [];
  const press = pressFeedback({ start: () => calls.push('start'),
    release: () => calls.push('release'), cancel: () => calls.push('cancel') });
  press(event('end'));
  press(event('start'));
  press(event('start'));
  press(event('change'));
  press(event('start', 'touch:two'));
  press(event('cancel', 'unrelated'));
  press(event('end'));
  assert.deepEqual(calls, ['start'], 'One contact released another contact’s feedback');
  press(event('cancel', 'touch:two'));
  assert.deepEqual(calls, ['start', 'cancel']);
  press(event('start'));
  press({ ...event('end'), inside: false });
  assert.deepEqual(calls, ['start', 'cancel', 'start', 'release'], 'Release outside lost capture');
  press(event('start'));
  press(event('start', 'touch:two'));
  press(event('cancel'));
  press(event('end', 'touch:two'));
  assert.equal(calls.at(-1), 'cancel', 'A cancelled control played successful feedback');
}

// Load the actual controls, replacing only their runtime boundary. Coordinates
// deliberately differ between owner-local and logical-window space.
async function controls(component) {
  const nodes = new Map(), ids = new Map(), animations = new Map(), played = [];
  const writes = [], subscriptions = new Map(), shellCalls = [];
  let next = 1, haptics = 0, allowed = true, opened = 0, panels = 0, windowRole, shellState = {}, unlocks = 0;
  const context = createContext({
    setTimeout: (callback, delay) => { if (delay < 1000) queueMicrotask(callback); },
    setInterval() {}, clearTimeout() {}
  });
  const noop = async () => true;
  const ui = {
    createElement: async (win, options) => {
      assert(!Object.keys(options).some(key => /^onMouse/.test(key)), 'Removed input registration');
      const id = next++; nodes.set(id, options); return id;
    },
    attach: noop, attachRoot: noop, setScale: noop, setPosition: noop, setTextString: noop,
    setEnabled: noop, setBoxColour: noop, setHitTarget: noop, setTexture: noop,
    setInheritAnimation: noop, destroyElement: noop,
    setElementId: async (win, id, name) => ids.set(name, id),
    addAnimation: async (win, id, frames) => {
      const animation = next++; animations.set(animation, { id, frames }); return animation;
    },
    updateAnimation: async (win, id, animation, frames) => { animations.set(animation, { id, frames }); return true; },
    startAnimation: async (win, id, animation) => played.push(animations.get(animation)),
    onAnimationEnd: noop
  };
  const modules = new Map();
  const stub = (name, values) => {
    const module = new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { identifier: name, context });
    modules.set(name, module);
  };
  stub('Helix/UserInterface', ui);
  stub('Helix/Log', { error: error => { throw new Error(error); } });
  stub('Module/dbus', { session: { onSignal() {}, addMatch: noop } });
  stub('Helix/Event', { on() {} });
  stub('Helix/Engine', { quit() { throw new Error('Unexpected engine quit'); } });
  stub('Module/pam', { authenticate() { throw new Error('Gesture attempted authentication'); } });
  stub('Koya/Compositor', {
    listDisplays: async options => {
      assert.equal(options?.backend, 'wayland', 'Display discovery must explicitly select Wayland for Koya 0.7+');
      return [{ display: 'test', width: 540, height: 960 }];
    },
    createWindow: async options => { windowRole = options.role; return 1; },
    getWindowInfo: async () => ({ role: windowRole, width: 540, height: 960 }),
    setClearColor: noop, setWindowRenderingEnabled: noop, sessionLockState: async () => 'locked',
    unlockSession: async () => { unlocks++; }
  });
  stub(resolve(root, 'apps/haptics.js'), { haptic: () => { ++haptics; } });
  stub(resolve(root, 'apps/wallpaper-surface.js'), { wallpaperSurface: noop });
  stub(resolve(root, 'apps/window-layout.js'), { windowLayout() {} });
  stub(resolve(root, 'apps/unlock-panel.js'), { unlockPanel: async () => {
    ++panels; return { input: { setEnabled: noop, clear() {}, dispose() {} } };
  } });
  stub(resolve(root, 'apps/notifications.js'), { createNotifications: () => ({ open: async () => { ++opened; } }) });
  stub(resolve(root, 'apps/volume.js'), { createVolume: () => ({}) });
  stub(resolve(root, 'apps/rotation.js'), { createRotation: () => ({}) });
  stub(resolve(root, 'apps/rotation-transition.js'), { rotationTransition: () => noop });
  stub(resolve(root, 'apps/session.js'), { connect: (component, onState) => subscriptions.set(component, next => { shellState = next; return onState(next); }), call: async (method, signature, value) => {
    shellCalls.push(method);
    if (method === 'GetState') return shellState;
    if (method === 'BeginGraceUnlock') { assert.equal(shellState.AuthenticationRequired, false); return; }
    if (method === 'Unlock') return true;
    if (method === 'SetBrightness') { writes.push(value); return { Available: true, Percent: value }; }
    if (method === 'GetBrightness') return { Available: true, Percent: 50 };
    throw new Error('Unexpected shell call: ' + method);
  } });
  const load = async path => {
    if (!modules.has(path)) modules.set(path, new SourceTextModule(await readFile(path, 'utf8'), { identifier: path, context }));
    return modules.get(path);
  };
  const entry = new SourceTextModule(`export * from './apps/touch-ui.js'; export * from './apps/brightness.js';` +
    (component ? `export {default as build} from './apps/${component}.js';` : ''),
    { identifier: resolve(root, 'test-entry.js'), context });
  await entry.link((name, from) => load(name.startsWith('.') ? resolve(dirname(from.identifier), name) : name));
  await entry.evaluate();
  return { ...entry.namespace, nodes, ids, played, writes, subscriptions, shellCalls,
    opened: () => opened, panels: () => panels, unlocks: () => unlocks,
    haptics: () => haptics, allowed: () => allowed, deny: () => { allowed = false; } };
}

{
  const ui = await controls();
  let actions = 0, previews = 0;
  const id = await ui.button(1, 0, '', 48, 48, () => { ++actions; }, {
    onPress: () => { ++previews; }, onRelease: () => { --previews; }
  });
  const button = ui.nodes.get(id);
  button.onPress(event('start'));
  button.onPress(event('start', 'touch:two'));
  button.onPress(event('cancel'));
  assert.equal(previews, 1);
  button.onPress(event('cancel', 'touch:two'));
  assert.equal(previews, 0, 'Cancellation left a key preview or repeat active');
  assert.equal(actions, 0, 'Cancellation activated a button');
  assert.equal(ui.haptics(), 1);
  button.onPress(event('start'));
  button.onPress({ ...event('end'), inside: false });
  assert.equal(actions, 0, 'Captured release outside activated a button');
  button.onActivate({ ...event(undefined), kind: 'activate' });
  assert.equal(actions, 1);
  const row = ui.nodes.get(await ui.row(1, 0, 200, 48, () => { ++actions; }));
  row.onPress(event('start')); row.onPress(event('cancel'));
  const toggle = ui.nodes.get((await ui.toggle(1, 0, false, () => { ++actions; })).id);
  toggle.onPress(event('start')); toggle.onPress(event('cancel'));
  assert.equal(actions, 1, 'Cancelled row or switch performed an action');
  assert.equal(ui.played.at(-1).frames.at(-1).scale.x, 1, 'Cancelled switch did not settle');
}

{
  const ui = await controls(), brightness = ui.createBrightness(ui.allowed);
  await brightness.attach(1, 0, 400); await brightness.refresh();
  let slider = ui.nodes.get(ui.ids.get('brightness-slider'));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  slider.onPress(event('start', 'touch:one', { x: 14, y: 36 })); await flush();
  assert.equal(ui.writes.at(-1), 5, 'Slider used window coordinates instead of event.local');
  slider.onPress(event('start', 'touch:two', { x: 1000, y: 36 }));
  slider.onPress(event('end', 'touch:two', { x: 1000, y: 36 })); await flush();
  assert.equal(ui.writes.at(-1), 5, 'Another finger stole the slider');
  slider.onPress({ ...event('change', 'touch:one', { x: 1000, y: 36 }), inside: false }); await flush();
  assert.equal(ui.writes.at(-1), 100, 'Captured slider movement outside did not clamp');
  const count = ui.writes.length;
  slider.onPress(event('cancel', 'touch:one', { x: 14, y: 36 }));
  slider.onPress(event('change', 'touch:one', { x: 14, y: 36 })); await flush();
  assert.equal(ui.writes.length, count, 'Cancelled slider kept writing brightness');
  await brightness.attach(1, 0, 400);
  slider.onPress(event('start', 'touch:old', { x: 14, y: 36 })); await flush();
  assert.equal(ui.writes.length, count, 'A stale slider handler changed brightness after rebuild');
  slider = ui.nodes.get(ui.ids.get('brightness-slider'));
  slider.onPress(event('start', 'touch:new', { x: 14, y: 36 })); await flush();
  ui.deny(); brightness.onState({});
  const disabledCount = ui.writes.length;
  slider.onPress(event('end', 'touch:new', { x: 1000, y: 36 })); await flush();
  assert.equal(ui.writes.length, disabledCount, 'Inactive shell accepted a slider write');
}

{
  const ui = await controls('top-bar');
  await ui.build();
  const target = ui.nodes.get(ui.ids.get('top-bar-gesture'));
  const drag = (phase, id, x, y) => ({ ...event(phase, id), kind: 'drag', displacement: { x, y } });
  target.onDrag(drag('cancel', 'cancelled', 0, 200));
  assert.equal(ui.opened(), 0, 'Cancelled top bar gesture opened notifications');
  target.onDrag(drag('start', 'horizontal', 200, 20));
  target.onDrag(drag('end', 'horizontal', 200, 20));
  assert.equal(ui.opened(), 0, 'Sideways drag opened notifications');
  target.onDrag(drag('start', 'down', 1, 12));
  target.onDrag(drag('change', 'down', 1, 60));
  target.onDrag(drag('end', 'down', 1, 100));
  assert.equal(ui.opened(), 1, 'One downward swipe opened notifications more than once');
  target.onActivate({ ...event(undefined), kind: 'activate' });
  assert.equal(ui.opened(), 2, 'Tap did not open notifications');
}

{
  const ui = await controls('lock-screen');
  await ui.build();
  await ui.subscriptions.get('lock-screen')({ Active: true, ScreenState: 'locked', SecureLocked: true, LockGeneration: 1 });
  const target = ui.nodes.get(ui.ids.get('lock-swipe'));
  const drag = (phase, id, x, y) => ({ ...event(phase, id), kind: 'drag', start: { x: 150, y: 800 }, position: { x, y } });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  target.onDrag(drag('start', 'first', 150, 750));
  target.onDrag(drag('start', 'second', 150, 600));
  target.onDrag(drag('end', 'second', 150, 500));
  await flush();
  assert.equal(ui.panels(), 0, 'Another contact completed the owned lock swipe');
  target.onDrag(drag('cancel', 'first', 150, 500));
  target.onDrag(drag('end', 'first', 150, 500));
  await flush();
  assert.equal(ui.panels(), 0, 'Cancelled swipe exposed credential entry');
  target.onDrag(drag('start', 'sideways', 350, 750));
  target.onDrag(drag('end', 'sideways', 350, 650));
  await flush();
  assert.equal(ui.panels(), 0, 'Sideways swipe exposed credential entry');
  target.onDrag(drag('start', 'up', 150, 750));
  target.onDrag(drag('end', 'up', 155, 600));
  await flush();
  assert.equal(ui.panels(), 1, 'Deliberate upward swipe did not reveal credential entry');
  assert.deepEqual(ui.shellCalls, [], 'A lock gesture bypassed authentication');
}

{
  const ui = await controls('lock-screen'); await ui.build();
  const state = { Active: true, ScreenState: 'off', SecureLocked: true, LockGeneration: 1, AuthenticationRequired: false, PowerMenuState: 'closed' };
  await ui.subscriptions.get('lock-screen')(state);
  assert.equal(ui.unlocks(), 0, 'Screen-off released the compositor lock');
  await ui.subscriptions.get('lock-screen')({ ...state, ScreenState: 'locked' });
  assert.equal(ui.unlocks(), 1, 'Wake during grace did not release the compositor lock');
  assert.deepEqual(ui.shellCalls, ['GetState', 'BeginGraceUnlock', 'Unlock'], 'Grace wake did not use the coordinator-authorized unlock path');
  assert.equal(ui.panels(), 0, 'Grace wake opened credential entry');
}
{
  const ui = await controls('lock-screen'); await ui.build();
  await ui.subscriptions.get('lock-screen')({ Active: true, ScreenState: 'locked', SecureLocked: true, LockGeneration: 1, AuthenticationRequired: true, PowerMenuState: 'closed' });
  assert.equal(ui.unlocks(), 0, 'Authenticated lock was released without credentials');
}
{
  const timers = new Map(); let serial = 0, requests = 0;
  const context = createContext({ setTimeout: callback => { timers.set(++serial, callback); return serial; }, clearTimeout: id => timers.delete(id) });
  const module = new SourceTextModule(await readFile(resolve(root, 'apps/suspend.js'), 'utf8'), { context });
  await module.link(() => { throw new Error('Unexpected suspend policy dependency'); }); await module.evaluate();
  const policy = module.namespace.suspendPolicy(async () => { requests++; }, error => { throw new Error(error); });
  const off = { Active: true, ScreenState: 'off', DisplayOff: true, IdleSuspendSeconds: 1, 'lock-screenStatus': 'ready', PowerMenuState: 'closed' };
  policy.onState(off); const stale = [...timers.values()][0];
  policy.onState({ ...off, CaffeineActive: true });
  assert.equal(timers.size, 0, 'Caffeine retained an automatic suspend timer');
  await stale(); assert.equal(requests, 0, 'Cancelled timer suspended a caffeinated session');
  policy.onState(off); assert.equal(timers.size, 1);
  await [...timers.values()][0](); assert.equal(requests, 1);
  policy.dispose();
}
console.log('PASS: virtual controls, cancellation, multitouch, slider capture, grace unlock and lock/top-bar gestures');

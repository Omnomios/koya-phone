import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function drawer() {
  let serial = 0, launches = 0, reject = false, defer, resolveLaunch;
  const nodes = new Map(), ids = new Map(), timers = new Map(), calls = [], errors = [], feedback = [];
  let desktop = { workspaces: [{ id: 1 }], clients: [], active: { id: 1 } };
  const app = { id: 'example.desktop', name: 'Example', class: 'example' };
  const state = { Active: true, ScreenState: 'unlocked', PowerMenuState: 'closed', DesktopView: 'apps' };
  const noop = async () => {};
  const context = createContext({
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const create = options => { const id = ++serial; nodes.set(id, options); return id; };
  const destroy = id => {
    for (const [child, node] of nodes) if (node.parent === id) destroy(child);
    nodes.delete(id);
    for (const [name, value] of ids) if (value === id) ids.delete(name);
  };
  const ui = {
    createElement: async (win, options) => create(options),
    attach: async (win, parent, child) => { nodes.get(child).parent = parent; }, attachRoot: noop,
    setElementId: async (win, id, name) => ids.set(name, id),
    setTextString: async (win, id, text) => { nodes.get(id).text = text; },
    destroyElement: async (win, id) => destroy(id),
    setAnimationTime: noop, setInheritAnimation: noop, setEnabled: noop, stopAnimation: noop, setLayoutSize: noop
  };
  const call = async (method, signature, ...args) => {
    calls.push({ method, args });
    if (method === 'GetApplications') return [app];
    if (method === 'GetDesktopState') return {
      workspaces: JSON.stringify(desktop.workspaces), clients: JSON.stringify(desktop.clients), activeworkspace: JSON.stringify(desktop.active)
    };
    if (method === 'LaunchApplication') {
      launches++;
      if (reject) throw new Error('Dispatch failed');
      if (defer) return new Promise(resolve => { resolveLaunch = resolve; });
      return 'launch-' + launches;
    }
  };
  const modules = new Map();
  const stub = (name, values) => modules.set(name, new SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { identifier: name, context }));
  stub('Helix/UserInterface', ui);
  stub('Helix/Log', { error: value => errors.push(value) });
  stub('Helix/Event', { on() {} });
  stub('Module/process', { getEnv: (name, fallback) => fallback });
  stub('Koya/Assets', { mount: noop });
  stub('Koya/Compositor', {
    createWindow: async () => 1, getWindowInfo: async () => ({ width: 540, height: 1028 }),
    listDisplays: async () => [{ display: 'test', width: 540, height: 1140 }],
    setWindowRenderingEnabled: noop, setClearColor: noop, setPointerEvents: noop, setKeyboardInteractivity: noop, destroyWindow: noop
  });
  stub(resolve(root, 'apps/session.js'), { call });
  stub(resolve(root, 'apps/window-layout.js'), { windowLayout() {} });
  stub(resolve(root, 'apps/wallpaper-surface.js'), { resizeWallpaper: noop });
  stub(resolve(root, 'apps/motion.js'), { clips: async () => {
    const ends = new Map();
    return { ids: {}, onEnd: async (name, callback) => ends.set(name, callback), play: async name => ends.get(name)?.() };
  } });
  const label = async (win, parent, text) => create({ parent, text });
  stub(resolve(root, 'apps/touch-ui.js'), {
    label, text: label, backdrop: async () => create({}),
    sheetHeader: async (win, parent, text, width, actions, accessory) => {
      await accessory.build(create({ parent })); return { heading: await label(win, parent, text) };
    },
    button: async (win, parent, text, width, height, action, options) => {
      const motion = { active: false, begin: async () => { motion.active = true; }, end: async () => { motion.active = false; } };
      feedback.push(motion); options.onFeedback?.(motion);
      return create({ parent, text, action });
    }
  });
  const load = async path => {
    if (!modules.has(path)) modules.set(path, new SourceTextModule(await readFile(path, 'utf8'), { identifier: path, context }));
    return modules.get(path);
  };
  const entry = await load(resolve(root, 'apps/desktop-view.js'));
  await entry.link((name, from) => load(name.startsWith('.') ? resolve(dirname(from.identifier), name) : name));
  await entry.evaluate();
  const controller = entry.namespace.createDrawerController({ display: 'test', width: 540, height: 1140 });
  await controller.onState(state); await flush();
  const tap = () => nodes.get(ids.get('desktop-app-example.desktop')).action();
  return {
    controller, tap, timers, calls, errors, state, feedback,
    text: () => [...nodes.values()].map(node => node.text || '').join('\n'),
    active: () => feedback.some(motion => motion.active),
    launches: () => launches,
    reject: () => { reject = true; }, defer: () => { defer = true; }, reply: id => resolveLaunch(id),
    event: (id, kind, status = 0, pid = 42) => controller.onLaunch({ id, state: kind, status, pid, message: 'Child exited' }),
    expire: async () => {
      for (const [id, timer] of [...timers]) if (timer.delay === 15000) { timers.delete(id); timer.callback(); }
      await flush();
    },
    clients: async clients => { desktop = { ...desktop, clients }; await controller.onDesktop(); await flush(); }
  };
}

{
  const ui = await drawer();
  await ui.tap(); assert(ui.active());
  await ui.event('launch-1', 'started');
  await ui.event('launch-1', 'exited', 7);
  assert.match(ui.text(), /Unable to open Example/);
  assert(!ui.active(), 'Failed process left launch feedback running');
  assert.equal(ui.timers.size, 0, 'Failed launch retained its timeout');
  await ui.tap(); assert.equal(ui.launches(), 2, 'Failed app could not be retried');
  assert(!ui.text().includes('Unable to open Example'), 'Retry retained the previous error');
  await ui.event('launch-1', 'exited', 7);
  assert(ui.active(), 'Previous launch failure cancelled the retry');
  await ui.event('launch-2', 'exited', -15);
  assert.match(ui.text(), /Unable to open Example/);
}
{
  const ui = await drawer(); ui.defer();
  const launched = ui.tap(); await flush();
  await ui.event('launch-1', 'started'); await ui.event('launch-1', 'exited', 1);
  ui.reply('launch-1'); await launched;
  assert.match(ui.text(), /Unable to open Example/, 'Exit before launch reply was lost');
}
{
  const ui = await drawer();
  await ui.tap(); await ui.event('launch-1', 'started');
  // PID can identify a window even if its class/workspace differ from the entry.
  await ui.clients([{ address: '0xabc', pid: 42, class: 'different', workspace: { id: 3 } }]);
  assert(ui.calls.some(call => call.method === 'FocusWindow' && call.args[0] === '0xabc'));
  assert(!ui.active()); assert.equal(ui.timers.size, 0);
  await ui.event('launch-1', 'exited', 1); await ui.expire();
  assert(!ui.text().includes('Unable to open'), 'An already opened app was reported as a failed launch');
}
{
  const ui = await drawer(); await ui.tap();
  await ui.clients([{ address: '0xdef', pid: 42, class: 'different', workspace: { id: 3 } }]);
  assert(ui.active());
  await ui.event('launch-1', 'started');
  assert(ui.calls.some(call => call.method === 'FocusWindow' && call.args[0] === '0xdef'), 'Window before PID event was lost');
  assert(!ui.active()); assert.equal(ui.timers.size, 0);
}
{
  const ui = await drawer(); await ui.tap();
  // A successful wrapper exit may hand off to another process.
  await ui.event('launch-1', 'exited', 0);
  assert(ui.active()); assert(!ui.text().includes('Unable to open'));
  await ui.expire(); assert.match(ui.text(), /No window opened for Example/); assert(!ui.active());
  await ui.tap(); assert.equal(ui.launches(), 2);
  await ui.controller.onState({ ...ui.state, DesktopView: 'closed' });
  assert(!ui.active()); assert.equal(ui.timers.size, 0);
  await ui.event('launch-2', 'failed', 1); await ui.expire();
  assert(!ui.text().includes('Unable to open'), 'Dismissed drawer processed an old failure');
}
{
  const ui = await drawer(); ui.reject(); await ui.tap();
  assert.match(ui.text(), /Unable to open Example/); assert(!ui.active()); assert.equal(ui.timers.size, 0);
}
console.log('PASS: process failures, early exit race, retry, PID matching, window timeout and dismissal');

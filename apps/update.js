import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Engine from 'Helix/Engine';
import * as Event from 'Helix/Event';
import * as Process from 'Module/process';
import * as Log from 'Helix/Log';
import { connect } from './session.js';
import { windowLayout } from './window-layout.js';
import { button, label, backdrop, sheetHeader } from './touch-ui.js';
import { CREAM, ORANGE, INK, CARD, MUTED, BAR_HEIGHT, NAV_HEIGHT, GUTTER, SPACE, TYPE, TOUCH } from './theme.js';

const STATUS = '/var/lib/koya-shell/update.status';
const LOG = '/var/log/koya-shell/update.log';
const SCHEDULE = '/usr/local/libexec/koya-update-schedule';
const glyph = name => '/rom/assets/launcher/' + name + '.png';
const read = async command => {
  try { return (await Process.exec(command)).stdout.trim(); }
  catch (_) { return ''; }
};
const lines = value => value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(-480);

export default async () => {
  const display = (await Compositor.listDisplays())[0];
  if (!display) throw new Error('No display available');
  const requested = { x: Number(display.logical_width || display.width),
    y: Number(display.logical_height || display.height) - BAR_HEIGHT - NAV_HEIGHT };
  const win = await Compositor.createWindow({ role: 'window', title: 'Update Koya', appId: 'org.koya.Update',
    size: requested, display: display.display, msaaSamples: 1, acceptPointerEvents: true });
  await Compositor.setClearColor(win, ...INK);
  const info = await Compositor.getWindowInfo(win);
  const size = { x: info.width, y: Math.min(info.height, requested.y) };
  let shell = {}, status = '', log = '', error = '', active = false, launching = false, closed = false;
  let polling = false, queue = Promise.resolve();
  const enqueue = task => { queue = queue.then(task).catch(cause => Log.error('Update UI: ' + cause)); return queue; };
  const busy = () => launching || status === 'queued' || status === 'running';
  const stateText = () => {
    if (error) return error;
    if (launching) return 'Requesting administrator access…';
    if (status === 'queued') return 'Update queued. The installer will start shortly.';
    if (status === 'running') return 'Downloading and installing Koya…';
    if (status === 'succeeded') return 'Koya was updated successfully.';
    if (status === 'failed') return 'The update failed. Review the log below.';
    return 'Ready to install the latest configured Koya release.';
  };
  const paint = async () => {
    if (!shell.state) return;
    await UI.setTextString(win, shell.state, stateText());
    await UI.setTextColour(win, shell.state, status === 'failed' || error ? ORANGE : CREAM);
    await UI.setTextString(win, shell.log, lines(size.x > size.y ? log.split('\n').slice(-3).join('\n') : log) || 'No update log yet.');
    await UI.setTextString(win, shell.actionLabel, busy() ? 'Update in progress' : 'Install update');
    await UI.setTextColour(win, shell.actionLabel, busy() || !active ? MUTED : CREAM);
  };
  const request = async () => {
    if (busy() || !active) return;
    launching = true; error = '';
    await paint();
    try {
      await Process.exec('pkexec --disable-internal-agent ' + SCHEDULE);
      status = 'queued';
    } catch (cause) {
      error = lines(String(cause.stderr || cause.message || cause)) || 'Unable to start the update.';
      Log.error('Update request: ' + error);
    } finally {
      launching = false;
      await paint();
    }
  };
  const build = async () => {
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
      if (shell.root) await UI.destroyElement(win, shell.root);
      const root = await UI.createElement(win, { item: { size }, layout: { type: 'none' } });
      await UI.attachRoot(win, root);
      await backdrop(win, root, size, BAR_HEIGHT);
      const board = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.l,
        padding: { l: GUTTER, r: GUTTER, t: SPACE.s, b: GUTTER } }, item: { size } });
      await UI.attach(win, root, board);
      await sheetHeader(win, board, 'Update Koya', size.x - 2 * GUTTER, [
        { icon: glyph('close'), handler: () => { closed = true; Engine.quit(); } }
      ]);
      const width = size.x - 2 * GUTTER;
      const wide = size.x > size.y;
      const introHeight = wide ? 48 : 80;
      const stateHeight = wide ? 48 : 80;
      const logHeadingHeight = wide ? 24 : 32;
      const logHeight = Math.max(40, size.y - 56 - introHeight - stateHeight - TOUCH - 12 - logHeadingHeight - 5 * SPACE.l - GUTTER - SPACE.s);
      await label(win, board, 'Save your work before updating. Koya will close and reopen after installation.',
        TYPE.body, width, introHeight, CREAM);
      const state = await label(win, board, '', TYPE.heading, width, stateHeight, CREAM);
      const action = await button(win, board, '', width, TOUCH + 12, request, { colour: CARD });
      await UI.setElementId(win, action, 'update-install');
      const actionLabel = await label(win, action, '', TYPE.body, width, TOUCH + 12, CREAM);
      await label(win, board, 'Recent installer output', TYPE.caption, width, logHeadingHeight, MUTED);
      const logLabel = await label(win, board, '', TYPE.caption, width, logHeight, MUTED);
      shell = { root, state, actionLabel, log: logLabel };
      await paint();
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
  };
  await build();
  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const [nextStatus, nextLog] = await Promise.all([
        read('cat ' + STATUS), read('tail -n 6 ' + LOG)
      ]);
      if (nextStatus !== status || nextLog !== log) {
        status = nextStatus; log = nextLog;
        if (status === 'running' || status === 'succeeded' || status === 'failed') error = '';
        await enqueue(paint);
      }
    } finally { polling = false; }
  };
  setInterval(() => poll().catch(cause => Log.error('Update status: ' + cause)), 1500);
  poll().catch(cause => Log.error('Update status: ' + cause));
  connect('settings', next => { active = !!next.Active && next.ScreenState === 'unlocked'; enqueue(paint); });
  windowLayout(win, next => enqueue(async () => {
    if (next.x === size.x && next.y === size.y) return;
    Object.assign(size, next);
    await build();
  }));
  Event.on('keyDown', event => {
    if (event.id === win && [1, 27, 65307].includes(Number(event.key))) { closed = true; Engine.quit(); }
  });
  return win;
};

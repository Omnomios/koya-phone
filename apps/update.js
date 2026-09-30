import * as UI from 'Helix/UserInterface';
import * as Process from 'Module/process';
import * as Log from 'Helix/Log';
import { updateService } from './update-service.js';
import { connect } from './session.js';
import { appFrame } from './app-frame.js';
import { label, pill } from './touch-ui.js';
import { commitHash, shortHash, compareVersion } from './update-version.js';
import { FONT, CREAM, ORANGE, INK, CARD, TRACK, MUTED, alpha, SPACE, RADIUS, TYPE } from './theme.js';

const CONFIG = Process.getEnv('KOYA_UPDATE_CONFIG', '/etc/koya-shell/update.conf');
const VERSION_CHECK_INTERVAL = 5 * 60 * 1000;
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const fields = value => Object.fromEntries(value.split('\n').map(line => {
  const separator = line.indexOf('=');
  return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
}));
const validRepo = value => /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value) && !value.includes('..');
const validRef = value => /^[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..') && !value.startsWith('/');
const read = async command => {
  try { return (await Process.exec(command)).stdout.trim(); }
  catch (_) { return ''; }
};
const clean = value => value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
const explain = message => /cancel|refused|not authori/i.test(message) ? 'Administrator approval was refused or cancelled' : message;

// The update's life, as reported by the system service.
const STEPS = [
  { title: 'Approve', detail: 'Confirm with your password' },
  { title: 'Download', detail: 'Fetching the installer' },
  { title: 'Install', detail: 'Building and deploying Koya' },
  { title: 'Restart', detail: 'Koya reopens when it is done' }
];
const STEP = 52, DOT = 18;

export default async () => {
  let shell = {}, status = '', phase = '', log = '', error = '', starting = false, source = '', ready = false;
  let repo = '', ref = '', installed = '', localSource = false, versionKey = '', checkedKey = '', checkingKey = '', checkedAt = 0;
  let version = { kind: 'checking', head: '', message: 'Checking repository…' };
  // A reopened app shows a live job, without celebrating an old result again.
  let observedAttempt = false;
  const active = () => ready && shell.Active && shell.ScreenState === 'unlocked';
  const busy = () => starting || status === 'authorizing' || status === 'running';
  const progress = () => {
    if (starting || status === 'authorizing') return { index: 0 };
    if (status === 'running') return { index: phase === 'install' ? 2 : 1 };
    if (status === 'succeeded' && observedAttempt) return { index: 3, done: true };
    if (status === 'failed' && observedAttempt) return { index: phase === 'install' ? 2 : phase === 'download' ? 1 : 0, failed: true };
    return { index: -1 };
  };
  const statusHint = () => error ? explain(error) : starting || status === 'authorizing' ? 'Waiting for approval…'
    : status === 'running' ? 'Updating. Koya will restart when it is done.' : status === 'succeeded' && observedAttempt ? 'Update complete.'
    : !ready ? 'Connecting to the shell…' : !active() ? 'Unlock the phone to update' : '';

  let onLogPage = false;
  const frame = await appFrame({ title: 'Update Koya', appId: 'org.koya.Update', name: 'Update',
    hint: statusHint, onBack: () => onLogPage && openHome(-1) });
  const { win, play, hidden, punch, shake, flash, host } = frame;

  // ---- Home ----------------------------------------------------------------
  const homeBuild = async () => {
    const page = await frame.newPage(SPACE.m), ok = frame.live(page);
    page.hint = 'Save your work first. Koya closes and reopens after installing.';
    const wide = frame.size.x > frame.size.y;
    const width = frame.width, columnWidth = wide ? (width - SPACE.l) / 2 : width;
    // Wide screens: steps on the left, actions on the right. Portrait uses
    // the page's own column.
    let left = page.el, right = page.el;
    if (wide) {
      const columnHeight = frame.stageHeight - SPACE.xs - 20;
      const body = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.l }, item: { size: { x: width, y: columnHeight } } });
      await UI.attach(win, page.el, body);
      left = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.m }, item: { size: { x: columnWidth, y: columnHeight } } });
      right = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.m }, item: { size: { x: columnWidth, y: columnHeight } } });
      await UI.attach(win, body, left);
      await UI.attach(win, body, right);
    }

    // Where updates come from. On wide screens it heads the action column so
    // the stepper has the full height of its own.
    const origin = await UI.createElement(win, { renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.surface, cornerResolution: 16 },
      layout: { type: 'column', justifyContent: 'center', padding: { l: 16, r: 16, t: 0, b: 0 } }, item: { size: { x: columnWidth, y: 116 } }, contentAlign: 'fill' });
    await UI.attach(win, wide ? right : left, origin);
    await label(win, origin, 'Koya Shell', TYPE.body, columnWidth - 32, 26);
    const sourceLabel = await label(win, origin, source || 'Update source not configured', TYPE.caption, columnWidth - 32, 22, source ? MUTED : ORANGE);
    const revisionLabel = await label(win, origin, '', TYPE.caption, columnWidth - 32, 22, MUTED);
    const versionLabel = await label(win, origin, version.message, TYPE.caption, columnWidth - 32, 22, MUTED);
    await UI.setElementId(win, versionLabel, 'update-version');
    page.items.push(origin);

    // The stepper: one quiet card, a dot per step and a rail between them.
    const steps = await UI.createElement(win, { renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.surface, cornerResolution: 16 },
      layout: { type: 'column', padding: { l: 16, r: 16, t: SPACE.s, b: SPACE.s } }, item: { size: { x: columnWidth, y: STEPS.length * STEP + 2 * SPACE.s } }, contentAlign: 'fill' });
    await UI.attach(win, left, steps);
    const marks = [];
    for (const [index, step] of STEPS.entries()) {
      const line = await UI.createElement(win, { layout: { type: 'row', alignItems: 'center', gap: SPACE.m }, item: { size: { x: columnWidth - 32, y: STEP } } });
      await UI.attach(win, steps, line);
      // Layout-less column: ring, fill and rail overlap in one slot.
      const marker = await UI.createElement(win, { item: { size: { x: 24, y: STEP } } });
      await UI.attach(win, line, marker);
      // The rail runs from this dot's lower edge to the next dot's upper edge,
      // overflowing its own slot into the next line.
      const rail = index < STEPS.length - 1 ? await UI.createElement(win, {
        renderable: { type: 'box', colour: TRACK, aabb: { min: { x: 0, y: 0 }, max: { x: 2, y: STEP - DOT } } },
        item: { size: { x: 24, y: STEP } }, contentAlign: { x: 'center', y: 'start' }, contentPositioning: 'raw' }) : undefined;
      if (rail) { await UI.attach(win, marker, rail); await UI.setPosition(win, rail, { x: 0, y: (STEP + DOT) / 2 }); }
      const ring = await UI.createElement(win, { renderable: { type: 'circle', aabb: { min: { x: 0, y: 0 }, max: { x: DOT, y: DOT } }, resolution: 32, inset: 2, colour: MUTED },
        item: { size: { x: 24, y: STEP } }, contentAlign: { x: 'center', y: 'center' } });
      await UI.attach(win, marker, ring);
      const dot = await UI.createElement(win, { renderable: { type: 'circle', aabb: { min: { x: 0, y: 0 }, max: { x: DOT, y: DOT } }, resolution: 32, colour: ORANGE, origin: { x: 0.5, y: 0.5 } },
        item: { size: { x: 24, y: STEP } }, contentAlign: { x: 'center', y: 'center' } });
      await UI.attach(win, marker, dot);
      await hidden(dot);
      const words = await UI.createElement(win, { layout: { type: 'column', justifyContent: 'center' }, item: { size: { x: columnWidth - 32 - 24 - SPACE.m, y: STEP } } });
      await UI.attach(win, line, words);
      const titleId = await label(win, words, step.title, TYPE.body, columnWidth - 32 - 24 - SPACE.m, 24, MUTED);
      const detailId = await label(win, words, step.detail, TYPE.caption - 1, columnWidth - 32 - 24 - SPACE.m, 20, alpha(MUTED, 0.7));
      marks.push({ line, ring, dot, rail, title: titleId, detail: detailId, state: 'pending' });
    }
    page.items.push(steps);

    // The one primary action: filled, full width, thumb height.
    let feedback, actionLabel;
    const install = async () => {
      if (!ok()) return;
      if (busy()) { punch(button, 1.03); return; }
      if (!active()) { shake(button); flash('Unlock the phone to update', ORANGE); return; }
      observedAttempt = true;
      starting = true; error = '';
      await paint(true);
      try { await updater.start(); }
      catch (cause) { error = clean(String(cause.message || cause)); }
      finally {
        starting = false;
        await frame.enqueue(async () => { await frame.current?.update(); await frame.refreshHint(); });
        if (error) flash(explain(error), ORANGE, 4000);
      }
    };
    const button = await pill(win, right, 'Install update', columnWidth, install, { colour: ORANGE, labelColour: INK, height: 56, size: TYPE.body + 1,
      onFeedback: value => { feedback = value; }, onLabel: id => { actionLabel = id; } });
    await UI.setElementId(win, button, 'update-install');
    page.items.push(button);
    const logRow = await frame.navigate(right, 'Installer output', 'No output yet', 72, () => ok() && openLog(), { width: columnWidth });
    await UI.setElementId(win, logRow.target, 'update-log');
    page.items.push(logRow.target);

    // Paint reflects status in place; `animate` marks a live change.
    let painted = -2, waiting = false;
    const paint = async animate => {
      const { index, done, failed } = progress();
      for (const [i, mark] of marks.entries()) {
        const next = done || i < index ? 'done' : i === index ? failed ? 'failed' : 'active' : 'pending';
        if (next === mark.state) continue;
        const was = mark.state;
        mark.state = next;
        await UI.setCircleColour(win, mark.ring, next === 'pending' ? MUTED : ORANGE);
        await UI.setTextColour(win, mark.title, next === 'pending' ? MUTED : next === 'failed' ? ORANGE : CREAM);
        await UI.setTextString(win, mark.detail, next === 'failed' ? 'Failed here' : next === 'done' && i === 3 ? 'Complete' : STEPS[i].detail);
        if (mark.rail) await UI.setBoxColour(win, mark.rail, next === 'done' ? ORANGE : TRACK);
        if (next === 'pending') await hidden(mark.dot);
        else if (next === 'active') {
          // The current step breathes while it runs; nothing loops at rest.
          play(mark.dot, [{ time: 0, scale: { x: 0, y: 0 }, opacity: 1 }, { time: 0.18, scale: { x: 0.7, y: 0.7 }, opacity: 1, ease: 'outCubic' },
            { time: 0.75, scale: { x: 0.35, y: 0.35 }, opacity: 0.6, ease: 'inOutQuad' }, { time: 1.3, scale: { x: 0.7, y: 0.7 }, opacity: 1, ease: 'inOutQuad', looping: true }]);
          if (animate) punch(mark.line, 1.03);
        } else {
          play(mark.dot, animate && was !== next
            ? [{ time: 0.12, scale: { x: 1.3, y: 1.3 }, opacity: 1, ease: 'outCubic' }, { time: 0.28, scale: { x: 1, y: 1 }, opacity: 1, ease: 'inOutQuad' }]
            : [{ time: 0, scale: { x: 1, y: 1 }, opacity: 1 }]);
          if (next === 'failed' && animate) shake(mark.line);
        }
      }
      const running = busy();
      if (running !== waiting) { waiting = running; running ? feedback?.begin().catch(() => {}) : feedback?.end().catch(() => {}); }
      await UI.setTextString(win, actionLabel, starting || status === 'authorizing' ? 'Waiting for approval…' : running ? 'Updating…'
        : (status === 'failed' && observedAttempt) || error ? 'Try again' : 'Install update');
      // Dim the action only while the phone is locked.
      play(button, [{ time: 0.2, opacity: !active() ? 0.45 : 1, ease: 'outCubic' }]);
      const last = clean(log).trim().split('\n').filter(Boolean).pop() || '';
      await UI.setTextString(win, logRow.valueLabel, last ? last.slice(0, 64) : 'No output yet');
      await UI.setTextString(win, sourceLabel, source || 'Update source not configured');
      await UI.setTextColour(win, sourceLabel, source ? MUTED : ORANGE);
      await UI.setTextString(win, revisionLabel, `Installed ${shortHash(installed)} · Repo ${shortHash(version.head)}`);
      await UI.setTextString(win, versionLabel, version.message);
      await UI.setTextColour(win, versionLabel, version.kind === 'behind' || version.kind === 'diverged' ? ORANGE : MUTED);
      if (animate && index !== painted && status === 'succeeded' && observedAttempt) flash('Koya was updated', ORANGE, 4000);
      painted = index;
    };
    await paint(false);
    page.update = () => paint(true);
    page.dispose = () => feedback?.end().catch(() => {});
    return page;
  };

  // ---- Installer output -----------------------------------------------------
  const logBuild = async () => {
    const page = await frame.newPage(SPACE.m), width = frame.width;
    page.hint = 'Latest installer output';
    const height = frame.stageHeight - SPACE.xs - 20;
    const card = await UI.createElement(win, { renderable: { type: 'box', colour: alpha(INK, 0.9), cornerRadius: RADIUS.surface, cornerResolution: 16 },
      layout: { type: 'column', padding: { l: 16, r: 16, t: SPACE.m, b: SPACE.m } }, item: { size: { x: width, y: height } }, contentAlign: 'fill', clipToBounds: true });
    await UI.attach(win, page.el, card);
    // Top-aligned and wrapped, like a terminal: labels centre vertically.
    const textSize = { x: width - 32, y: height - 2 * SPACE.m };
    const body = await UI.createElement(win, {
      renderable: { type: 'text', string: '', size: TYPE.caption, font: FONT, colour: CREAM, layoutMode: 'word-wrap', justify: 'left', vAlign: 'start',
        metricsBasis: 'line', aabb: { min: { x: 0, y: 0 }, max: textSize } },
      item: { size: textSize }, contentAlign: { x: 'start', y: 'start' }, clipToBounds: true });
    await UI.attach(win, card, body);
    page.items.push(card);
    // Show the newest lines that fit; long lines wrap, so budget generously.
    const fit = Math.max(4, Math.floor((height - 2 * SPACE.m) / 21) - 2);
    page.update = async () => UI.setTextString(win, body, clean(log).trim().split('\n').slice(-fit).join('\n') || 'No installer output yet.');
    await page.update();
    return page;
  };

  const openHome = direction => { onLogPage = false; return frame.go(homeBuild, { title: 'Update Koya', direction }); };
  const openLog = () => { onLogPage = true; return frame.go(logBuild, { title: 'Installer output', direction: 1, back: true }); };

  // ---- Status ---------------------------------------------------------------
  const checkVersion = async () => {
    const key = versionKey;
    if (!key || localSource || !validRepo(repo) || !validRef(ref) || checkingKey === key ||
        (checkedKey === key && Date.now() - checkedAt < VERSION_CHECK_INTERVAL)) return;
    checkingKey = checkedKey = key;
    checkedAt = Date.now();
    const request = async url => JSON.parse((await Process.exec('curl --fail --silent --show-error --location ' +
      '--proto \'=https\' --proto-redir \'=https\' --connect-timeout 8 --max-time 20 ' +
      '-H \'Accept: application/vnd.github+json\' ' + quote(url))).stdout);
    let head = '';
    try {
      head = commitHash((await request(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`)).sha);
      if (!head) throw new Error('Repository response has no commit');
      const next = !installed ? { kind: 'unknown', head, message: 'Installed revision unknown' }
        : head === installed ? compareVersion(installed, head)
          : compareVersion(installed, head,
            await request(`https://api.github.com/repos/${repo}/compare/${installed}...${head}?per_page=1`));
      if (key === versionKey) version = next;
    } catch (cause) {
      Log.error('Update version: ' + cause);
      if (key === versionKey) version = { kind: 'unavailable', head,
        message: head ? 'Could not compare revisions' : 'Could not check repository' };
    } finally {
      if (checkingKey === key) checkingKey = '';
      if (key === versionKey && !frame.closing) await frame.enqueue(() => frame.current?.update());
    }
  };
  let refreshQueue = Promise.resolve();
  const refresh = () => {
    const task = refreshQueue.then(async () => {
      if (frame.closing) return;
      const config = await read('cat ' + quote(CONFIG));
      const values = fields(config);
      const record = values.prefix ? fields(await read('cat ' + quote(values.prefix + '/current/install-record.txt'))) : {};
      const nextRepo = values.repo || '', nextRef = values.ref || '';
      const nextSource = nextRepo ? nextRepo + (nextRef ? ' · ' + nextRef : '') : '';
      const nextInstalled = commitHash(record.source_commit);
      const nextLocalSource = String(record.source || '').startsWith('local:');
      const nextKey = [nextRepo, nextRef, nextInstalled, nextLocalSource].join('\n');
      if (nextKey !== versionKey) {
        versionKey = nextKey;
        version = nextLocalSource ? { kind: 'local', head: '', message: 'Local source · comparison unavailable' }
          : !validRepo(nextRepo) || !validRef(nextRef) ? { kind: 'unavailable', head: '', message: 'Repository source unavailable' }
            : { kind: 'checking', head: '', message: 'Checking repository…' };
        checkedKey = ''; checkedAt = 0;
      }
      if (nextSource !== source || nextRepo !== repo || nextRef !== ref || nextInstalled !== installed || nextLocalSource !== localSource) {
        source = nextSource; repo = nextRepo; ref = nextRef; installed = nextInstalled; localSource = nextLocalSource;
        await frame.enqueue(async () => { await frame.current?.update(); await frame.refreshHint(); });
      }
    });
    refreshQueue = task.catch(cause => Log.error('Update status: ' + cause));
    return task;
  };
  const poll = async () => {
    try { await refresh(); } catch (_) { /* refresh already records the error */ }
    checkVersion().catch(cause => Log.error('Update version: ' + cause));
    if (!frame.closing) setTimeout(poll, 30000);
  };
  await frame.show(homeBuild, { title: 'Update Koya' });
  poll();
  const updater = updateService(async next => {
    if (frame.closing) return;
    status = next.State; phase = next.Phase || ''; log = next.Log || '';
    if (status === 'running' || status === 'authorizing') observedAttempt = true;
    error = status === 'failed' || status === 'unavailable' ? next.Message || 'Update failed' : '';
    await frame.enqueue(async () => { await frame.current?.update(); await frame.refreshHint(); });
  });
  connect('settings', next => {
    shell = next; ready = true;
    return frame.enqueue(async () => { await frame.current?.update(); await frame.refreshHint(); });
  }, undefined, undefined, () => updater.connect());
  globalThis.koyaUpdate = { window: win, settled: () => frame.settled, get status() { return status; }, openLog };
  return win;
};

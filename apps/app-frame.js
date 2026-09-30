import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Engine from 'Helix/Engine';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import { resizeWallpaper } from './wallpaper-surface.js';
import { windowLayout } from './window-layout.js';
import { haptic } from './haptics.js';
import { button, icon, label, text, row, backdrop } from './touch-ui.js';
import { CREAM, ORANGE, INK, MUTED, CLEAR, alpha, BAR_HEIGHT, NAV_HEIGHT, GUTTER, SPACE, RADIUS, TYPE, HEADER_HEIGHT, TOUCH } from './theme.js';

// The shared frame for Koya's full-screen apps (Settings, Wi-Fi, Update):
// a dimmed live wallpaper, a persistent header (back, title, close), one
// status line, a stage on which pages slide, and a page marker. The chrome
// never rebuilds; it reacts. Apps supply pages and decide where they lead.
export const glyph = name => '/rom/assets/launcher/' + name + '.png';
export const STATUS = 32;

export async function appFrame({ title: initialTitle, appId, name = initialTitle, hint = () => '', onBack, onClose }) {
  const display = (await Compositor.listDisplays())[0];
  if (!display) throw new Error('No display available');
  const requested = { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) - BAR_HEIGHT - NAV_HEIGHT };
  const win = await Compositor.createWindow({ role: 'window', title: initialTitle, appId,
    size: requested, display: display.display, msaaSamples: 1, acceptPointerEvents: true });
  await Compositor.setWindowRenderingEnabled(win, false);
  await Compositor.setClearColor(win, ...INK);
  const info = await Compositor.getWindowInfo(win);
  // Before the first configure, window info can report the whole output.
  const size = { x: info.width, y: Math.min(info.height, requested.y) };
  const metrics = () => ({ width: size.x - 2 * GUTTER, stageHeight: size.y - SPACE.s - HEADER_HEIGHT - STATUS });

  // ---- Motion ------------------------------------------------------------
  // Koya runs one animation per element at a time. Each element keeps a single
  // reusable clip; frames without a time-zero key blend from the current pose,
  // so a new effect interrupts the last one without snapping.
  const clipsOf = new Map();
  const play = (id, frames) => {
    const previous = clipsOf.get(id);
    const job = (async () => {
      const clip = previous && await previous;
      if (clip !== undefined && await UI.updateAnimation(win, id, clip, frames)) { await UI.startAnimation(win, id, clip); return clip; }
      const created = await UI.addAnimation(win, id, frames);
      await UI.startAnimation(win, id, created);
      return created;
    })();
    clipsOf.set(id, job.catch(() => undefined));
    return job.catch(error => Log.error(name + ' motion: ' + error));
  };
  const hidden = id => play(id, [{ time: 0, opacity: 0 }]);
  const punch = (id, amount = 1.05) => play(id, [
    { time: 0.08, scale: { x: amount, y: amount }, opacity: 1, ease: 'outQuad' },
    { time: 0.34, scale: { x: 1, y: 1 }, opacity: 1, ease: 'outCubic' }]);
  const shake = id => play(id, [-9, 8, -5, 3, 0].map((x, i) => ({ time: 0.05 * (i + 1), position: { x, y: 0 }, scale: { x: 1, y: 1 }, opacity: 1, ease: 'inOutQuad' })));
  const rise = (id, delay) => play(id, [
    { time: 0, opacity: 0, position: { x: 0, y: 14 } },
    { time: delay, opacity: 0, position: { x: 0, y: 14 } },
    { time: delay + 0.26, opacity: 1, position: { x: 0, y: -2 }, ease: 'outCubic' },
    { time: delay + 0.38, opacity: 1, position: { x: 0, y: 0 }, ease: 'inOutQuad' }]);
  // Scalable layout host: an invisible box, because bare containers ignore
  // their pivot and cannot carry a centred transform for their children.
  const host = (extra = {}) => ({ renderable: { type: 'box', colour: CLEAR, origin: { x: 0.5, y: 0.5 } }, contentAlign: 'fill', inheritAnimation: true, ...extra });

  let queue = Promise.resolve(), current, factory, closing = false, statusTimer;
  const enqueue = task => { queue = queue.then(task).catch(error => Log.error(name + ' UI: ' + error)); return queue; };

  // ---- Chrome ------------------------------------------------------------
  const fill = { x: 'auto', y: 'auto' };
  const root = await UI.createElement(win, { layout: { type: 'none' }, item: { size: fill } });
  await UI.attachRoot(win, root);
  // The live wallpaper sits dimmed behind the app, aligned with the desktop.
  const wall = await backdrop(win, root, size, BAR_HEIGHT);
  const shell = await UI.createElement(win, host({ layout: { type: 'column' }, item: { size: fill } }));
  await UI.attach(win, root, shell);
  const header = await UI.createElement(win, { layout: { type: 'row', alignItems: 'center', padding: { l: GUTTER - 12, r: GUTTER, t: SPACE.s, b: 0 } },
    item: { size: { x: 'auto', y: HEADER_HEIGHT + SPACE.s } } });
  await UI.attach(win, shell, header);
  const backButton = await button(win, header, '', TOUCH, HEADER_HEIGHT, () => backShown && onBack?.(), { colour: CLEAR, icon: glyph('previous'), iconSize: 22, radius: RADIUS.control });
  await UI.setElementId(win, backButton, 'app-back');
  // Unclipped text: the title slides into the back button's slot on a root
  // page, and a clipping label would cut off the part that moves.
  const title = await text(win, header, initialTitle, TYPE.title, 0, HEADER_HEIGHT, CREAM, undefined, 'left');
  await UI.setGrow(win, title, 1);
  await button(win, header, '', TOUCH, HEADER_HEIGHT, () => close(), { colour: CLEAR, icon: glyph('close'), iconSize: 22, radius: RADIUS.control });
  // A column, not a row: a fluid label only fills its parent's cross axis.
  // In a row it measured its initial empty string, stayed zero-wide and
  // clipped every later message away.
  const statusRow = await UI.createElement(win, { layout: { type: 'column', padding: { l: GUTTER, r: GUTTER, t: 0, b: 0 } }, item: { size: { x: 'auto', y: STATUS } } });
  await UI.attach(win, shell, statusRow);
  const status = await label(win, statusRow, '', TYPE.caption, 'auto', STATUS, MUTED);
  // Pages overlap on a clipped stage while they slide past each other.
  const stage = await UI.createElement(win, { layout: { type: 'none' }, clipToBounds: true, item: { size: { x: 'auto', y: 0 }, flexGrow: 1 } });
  await UI.attach(win, shell, stage);

  // Page marker for long lists. It stays in place across page turns: the
  // newly active dot hops and settles while the list slides underneath.
  // A child of the root, attached after the shell, so it always draws above
  // the pages that transitions add to the stage inside the shell.
  const pagerBar = await UI.createElement(win, host({ layout: { type: 'row', justifyContent: 'center', alignItems: 'center' },
    item: { position: { x: 0, y: size.y - GUTTER - TOUCH }, size: { x: 'auto', y: TOUCH } } }));
  await UI.attach(win, root, pagerBar);
  let pagerState;
  // Arrows dim through a wrapper: the button's own press clips would
  // otherwise replace an opacity clip on the button itself.
  const arrowSlot = async (glyphName, step) => {
    const slot = await UI.createElement(win, host({ layout: { type: 'row' }, item: { size: { x: 64, y: TOUCH } } }));
    await UI.attach(win, pagerBar, slot);
    await button(win, slot, '', 64, TOUCH, () => pagerState?.turn(step), { colour: CLEAR, icon: glyph(glyphName), iconSize: 22, radius: RADIUS.control });
    return slot;
  };
  const prevButton = await arrowSlot('previous', -1);
  const dotRow = await UI.createElement(win, { layout: { type: 'row', justifyContent: 'center', alignItems: 'center', gap: 14 }, item: { size: { x: 88, y: TOUCH } } });
  await UI.attach(win, pagerBar, dotRow);
  const nextButton = await arrowSlot('next', 1);
  let dots = [];
  const DOT = 9, DIM = alpha(ORANGE, 0.35);
  const dotPose = (on, animate) => !animate ? [{ time: 0, scale: on ? { x: 1, y: 1 } : { x: 0.7, y: 0.7 }, position: { x: 0, y: 0 }, opacity: 1 }]
    : on ? [{ time: 0.1, scale: { x: 1.35, y: 1.35 }, position: { x: 0, y: -6 }, opacity: 1, ease: 'outCubic' },
        { time: 0.22, scale: { x: 0.9, y: 1.1 }, position: { x: 0, y: 0 }, opacity: 1, ease: 'inQuad' },
        { time: 0.32, scale: { x: 1.08, y: 0.94 }, position: { x: 0, y: 0 }, opacity: 1, ease: 'outQuad' },
        { time: 0.42, scale: { x: 1, y: 1 }, position: { x: 0, y: 0 }, opacity: 1, ease: 'inOutQuad' }]
      : [{ time: 0.16, scale: { x: 0.7, y: 0.7 }, position: { x: 0, y: 0 }, opacity: 1, ease: 'outCubic' }];
  const arrow = (id, enabled) => play(id, [{ time: 0.16, opacity: enabled ? 1 : 0.3, ease: 'outCubic' }]);
  const syncPager = async next => {
    const previous = pagerState;
    pagerState = next;
    if (!next) {
      if (previous) play(pagerBar, [{ time: 0.14, opacity: 0, ease: 'inQuad' }]);
      await UI.setEnabled(win, pagerBar, false).catch(() => {});
      return;
    }
    await UI.setEnabled(win, pagerBar, true);
    const same = previous && previous.group === next.group && previous.count === next.count;
    if (!same) {
      for (const dot of dots) await UI.destroyElement(win, dot);
      dots = [];
      for (let i = 0; i < next.count; i++) {
        const dot = await UI.createElement(win, { renderable: { type: 'circle', aabb: { min: { x: 0, y: 0 }, max: { x: DOT, y: DOT } }, resolution: 24,
          colour: i === next.index ? ORANGE : DIM, origin: { x: 0.5, y: 0.5 } }, item: { size: { x: DOT + 4, y: TOUCH } }, contentAlign: { x: 'center', y: 'center' } });
        await UI.attach(win, dotRow, dot);
        await UI.setHitTarget(win, dot, false);
        play(dot, dotPose(i === next.index, false));
        dots.push(dot);
      }
      play(pagerBar, [{ time: 0, opacity: 0 }, { time: 0.25, opacity: 0 }, { time: 0.45, opacity: 1, ease: 'outCubic' }]);
    } else if (previous.index !== next.index) {
      await Promise.all([UI.setCircleColour(win, dots[previous.index], DIM), UI.setCircleColour(win, dots[next.index], ORANGE)]);
      play(dots[previous.index], dotPose(false, true));
      play(dots[next.index], dotPose(true, true));
    }
    arrow(prevButton, next.index > 0);
    arrow(nextButton, next.index < next.count - 1);
  };
  await UI.setEnabled(win, pagerBar, false);

  let backShown = false, titleText = initialTitle;
  const showBack = visible => {
    if (visible === backShown) return;
    backShown = visible;
    play(backButton, visible
      ? [{ time: 0, opacity: 0, scale: { x: 0.4, y: 0.4 } }, { time: 0.16, opacity: 1, scale: { x: 1.15, y: 1.15 }, ease: 'outCubic' }, { time: 0.3, opacity: 1, scale: { x: 1, y: 1 }, ease: 'inOutQuad' }]
      : [{ time: 0.12, opacity: 0, scale: { x: 0.4, y: 0.4 }, ease: 'inQuad' }]);
  };
  const titleShift = () => backShown ? 0 : -TOUCH + 12;
  const setTitle = (value, direction) => {
    if (value === titleText) { play(title, [{ time: 0.2, opacity: 1, position: { x: titleShift(), y: 0 }, ease: 'outCubic' }]); return; }
    titleText = value;
    const out = -16 * (direction || 1);
    play(title, [{ time: 0.09, opacity: 0, position: { x: titleShift() + out, y: 0 }, ease: 'inQuad' }]);
    setTimeout(async () => {
      if (titleText !== value) return;
      await UI.setTextString(win, title, value);
      play(title, [{ time: 0, opacity: 0, position: { x: titleShift() - out, y: 0 } },
        { time: 0.2, opacity: 1, position: { x: titleShift(), y: 0 }, ease: 'outCubic' }]);
    }, 95);
  };

  // One status line: the page's hint, or a short-lived reaction to an action.
  let statusText = '', statusTone = MUTED;
  const setStatus = async (value, tone = MUTED, lift = 8) => {
    if (value === statusText && tone === statusTone) return;
    statusText = value; statusTone = tone;
    await Promise.all([UI.setTextString(win, status, value), UI.setTextColour(win, status, tone)]);
    play(status, [{ time: 0, opacity: 0, position: { x: 0, y: lift } }, { time: 0.22, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }]);
  };
  const pageHint = () => hint() || current?.hint || '';
  const showHint = () => { clearTimeout(statusTimer); statusTimer = undefined; return setStatus(pageHint()); };
  // For background state changes: never cut a confirmation short.
  const refreshHint = () => statusTimer ? Promise.resolve() : setStatus(pageHint());
  // Short confirmations fade back to the hint quickly; problems linger.
  const flash = (value, tone = ORANGE, hold) => {
    clearTimeout(statusTimer);
    setStatus(value, tone, tone === ORANGE ? 10 : 8);
    statusTimer = setTimeout(showHint, hold ?? (tone === ORANGE && value.length > 16 ? 3200 : 1400));
  };

  // ---- Shared rows -------------------------------------------------------
  const chevron = async (parent, height) => {
    const id = await icon(win, parent, glyph('next'), 18, 24, height);
    return { id, nudge: on => play(id, [{ time: on ? 0.08 : 0.2, position: { x: on ? 5 : 0, y: 0 }, ease: on ? 'outQuad' : 'outCubic' }]) };
  };
  // Title, live value and a trailing chevron (or another trailing element)
  // that leans the way the tap will go.
  const navigate = async (parent, heading, value, height, handler, options = {}) => {
    const width = options.width || metrics().width;
    let arrowIcon;
    const trailing = options.trailing === undefined ? 24 : options.trailing;
    const target = await row(win, parent, width, height, handler, { onPress: () => arrowIcon?.nudge?.(true), onRelease: () => arrowIcon?.nudge?.(false), ...options });
    const detailWidth = width - 16 - 12 - trailing - (trailing ? SPACE.m : 0) - (options.lead || 0);
    if (options.leading) await options.leading(target);
    const detail = await UI.createElement(win, { layout: { type: 'column', justifyContent: 'center' }, item: { size: { x: detailWidth, y: height } } });
    await UI.attach(win, target, detail);
    const headingLabel = await label(win, detail, heading, options.headingSize || TYPE.body, detailWidth, options.headingSize ? 32 : 26);
    const valueLabel = await label(win, detail, value, TYPE.caption, detailWidth, 22, options.valueColour || MUTED);
    if (options.trailingBuild) arrowIcon = await options.trailingBuild(target);
    else if (trailing) arrowIcon = await chevron(target, height);
    return { target, headingLabel, valueLabel };
  };
  // Muted section caption with an optional trailing element (a pill).
  const section = async (parent, caption, trailingWidth = 0, build, width = metrics().width) => {
    const line = await UI.createElement(win, { layout: { type: 'row', alignItems: 'center' }, item: { size: { x: width, y: 40 } } });
    await UI.attach(win, parent, line);
    const captionId = await label(win, line, caption, TYPE.caption, width - trailingWidth, 40, MUTED);
    const extra = build ? await build(line) : undefined;
    return { line, caption: captionId, extra };
  };

  // ---- Pages -------------------------------------------------------------
  const newPage = async (gap = SPACE.s) => {
    const { stageHeight } = metrics();
    const el = await UI.createElement(win, host({ layout: { type: 'column', gap, padding: { l: GUTTER, r: GUTTER, t: SPACE.xs, b: GUTTER } },
      item: { size: { x: size.x, y: stageHeight } } }));
    await UI.attach(win, stage, el);
    await hidden(el);
    return { el, items: [], alive: true, update: () => {} };
  };
  const live = page => () => page.alive && page === current && !closing;

  // Forward pushes in from the right, back from the left; the outgoing page
  // drifts the other way and fades. Rows arrive in a quick stagger.
  // `build` is kept so a rotation can rebuild the same page in place.
  const show = async (build, { title: nextTitle, direction = 0, back = false, animate = true, dim = false } = {}) => {
    if (closing) return;
    const previous = current;
    factory = { build, title: nextTitle, back };
    if (previous && !animate) { previous.alive = false; await UI.destroyElement(win, previous.el); }
    const next = await build();
    current = next;
    showBack(back);
    if (nextTitle) setTitle(nextTitle, direction);
    showHint();
    const opacity = dim ? 0.45 : 1;
    const travel = size.x * 0.28 * direction;
    if (animate) play(next.el, direction
      ? [{ time: 0, opacity: 0, position: { x: travel, y: 0 } }, { time: 0.3, opacity, position: { x: 0, y: 0 }, ease: 'outCubic' }]
      : [{ time: 0, opacity: 0, position: { x: 0, y: 0 } }, { time: 0.2, opacity, ease: 'outCubic' }]);
    else await play(next.el, [{ time: 0, opacity, position: { x: 0, y: 0 } }]);
    if (animate) {
      next.items.forEach((id, index) => rise(id, 0.05 + index * 0.035));
      next.reveal?.();
    }
    await syncPager(next.pager);
    if (previous && animate) {
      previous.alive = false;
      previous.dispose?.();
      play(previous.el, [{ time: 0.22, opacity: 0, position: { x: -travel * 0.6, y: 0 }, ease: 'inQuad' }]);
      setTimeout(() => UI.destroyElement(win, previous.el).catch(error => Log.error(name + ' page: ' + error)), 260);
    }
    return next;
  };
  const go = (build, options) => { haptic(); return enqueue(() => show(build, options)); };
  // Dim the current page while the app cannot act (locked, disconnected).
  const setDim = dimmed => current && play(current.el, [{ time: 0.2, opacity: dimmed ? 0.45 : 1, ease: 'outCubic' }]);

  // Quit straight away: Hyprland animates closing windows from their last
  // frame. Fading our own content first left only the window's clear colour,
  // which showed as a flat green frame before the window disappeared.
  const close = () => {
    if (closing) return;
    closing = true;
    onClose?.();
    Engine.quit();
  };
  Event.on('keyDown', event => {
    if (event.id !== win || ![1, 27, 65307].includes(Number(event.key))) return;
    if (backShown && onBack) onBack(); else close();
  });

  windowLayout(win, next => enqueue(async () => {
    if (next.x === size.x && next.y === size.y) return;
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
      Object.assign(size, next);
      await Promise.all([
        UI.setLayoutPosition(win, pagerBar, { x: 0, y: size.y - GUTTER - TOUCH }),
        resizeWallpaper(win, wall, { x: size.x, y: size.y + BAR_HEIGHT })
      ]);
      // Rotation is a relayout, so replace the page in the same frame rather
      // than replaying navigation with overlapping old and new pages.
      if (factory && current) await show(factory.build, { title: factory.title, back: factory.back, animate: false, dim: current.dim });
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
  }));

  await hidden(backButton);
  play(title, [{ time: 0, opacity: 0, position: { x: titleShift(), y: 6 } }, { time: 0.3, opacity: 1, position: { x: titleShift(), y: 0 }, ease: 'outCubic' }]);
  await setStatus(pageHint());
  // Rendering starts with the chrome; the first page fades in when shown.
  await Compositor.setWindowRenderingEnabled(win, true);

  return {
    win, size, wall,
    get width() { return metrics().width; }, get stageHeight() { return metrics().stageHeight; },
    get current() { return current; }, get closing() { return closing; }, get settled() { return queue; },
    play, hidden, punch, shake, rise, host, enqueue,
    setStatus, flash, showHint, refreshHint, setTitle,
    chevron, navigate, section, newPage, live, show, go, setDim, close, syncPager
  };
}

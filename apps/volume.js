import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { pulseAudio } from './pulse-audio.js';
import { notificationSurface } from './notification-surface.js';
import { clips } from './motion.js';
import { icon, text } from './touch-ui.js';
import { CREAM, ORANGE, INK, TRACK, alpha, BAR_HEIGHT, NAV_HEIGHT, TYPE, RADIUS } from './theme.js';
import { haptic } from './haptics.js';

export function createVolume(display, options = {}) {
  const size = { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) };
  const hudSize = { x: 72, y: 280 };
  let state = {}, started = false, surface, glyph, label, fill, motion, timer, wanted = false, latest, lastKey;
  let queue = Promise.resolve();
  const enqueue = task => { queue = queue.then(task).catch(error => Log.error('Volume indicator: ' + error)); return queue; };
  const visible = () => state.Active && state.ScreenState !== 'off' && state.PowerMenuState === 'closed' && state.VolumeIndicatorEnabled !== false;
  const texture = name => '/rom/assets/status/' + name + '.png';
  const audio = pulseAudio({ ...options, changed: (value, requested) => {
    if (requested && value.available && latest?.available && (value.percent !== latest.percent || value.muted !== latest.muted)) haptic();
    latest = value;
    if (requested && visible()) {
      wanted = true;
      clearTimeout(timer);
      timer = setTimeout(() => { wanted = false; enqueue(reconcile); }, state.VolumeIndicatorTimeoutMs || 1800);
    }
    enqueue(reconcile);
  } });
  const build = async () => {
    const right = state.VolumeIndicatorSide === 'right', margin = state.VolumeIndicatorMargin ?? 16;
    const usable = Math.max(0, size.y - BAR_HEIGHT - NAV_HEIGHT - hudSize.y);
    const offset = { x: right ? size.x - margin - hudSize.x : margin,
      y: BAR_HEIGHT + usable * (state.VolumeIndicatorPositionPercent ?? 50) / 100 };
    surface = await notificationSurface(display, 'koya-volume', hudSize, offset, alpha(INK, 0.98), 'none',
      { pointerEvents: false, enterOffset: { x: right ? 16 : -16, y: 0 } });
    const win = surface.win;
    const column = await UI.createElement(win, { layout: { type: 'column', gap: 12, padding: { l: 12, r: 12, t: 16, b: 16 }, alignItems: 'center' }, item: { size: hudSize } });
    await UI.attach(win, surface.root, column);
    glyph = await icon(win, column, texture('volume'), 28, 48, 32);
    const track = await UI.createElement(win, {
      renderable: { type: 'box', colour: TRACK, cornerRadius: RADIUS.control, cornerResolution: 16, origin: { x: 0.5, y: 0.5 } },
      clipToBounds: true, clipToMask: true,
      item: { size: { x: 32, y: 160 } }, contentAlign: 'fill'
    });
    await UI.attach(win, column, track);
    fill = await UI.createElement(win, {
      // The rounded parent masks this square fill; its top edge stays flat.
      renderable: { type: 'box', colour: ORANGE, cornerRadius: 0, origin: { x: 0.5, y: 1 }, scale: { x: 1, y: 0 } },
      item: { size: { x: 32, y: 160 } }, contentAlign: 'fill'
    });
    await UI.attach(win, track, fill);
    await UI.setElementId(win, fill, 'volume-level');
    label = await text(win, column, '—', TYPE.caption + 1, 48, 28, CREAM);
    await UI.setElementId(win, label, 'volume-percent');
    motion = await clips(win, track, { change: [
      { time: 0.06, scale: { x: 1.08, y: 1 }, ease: 'outQuad' },
      { time: 0.22, scale: { x: 1, y: 1 }, ease: 'outCubic' }
    ] });
    await surface.prepare(); lastKey = undefined;
  };
  async function reconcile() {
    if (!wanted || !visible()) {
      if (surface?.shown) await surface.hide(!visible());
      return;
    }
    if (!surface || surface.closed) await build();
    const value = latest || { available: false, error: 'No audio output' };
    const key = JSON.stringify([value.available, value.percent, value.muted]);
    if (key !== lastKey) {
      lastKey = key;
      const muted = value.muted || value.percent === 0;
      await Promise.all([
        UI.setTexture(surface.win, glyph, texture(value.available ? muted ? 'volume-muted' : 'volume' : 'volume-unavailable')),
        UI.setTextString(surface.win, label, value.available ? value.percent + '%' : '—'),
        UI.setScale(surface.win, fill, { x: 1, y: value.available && !value.muted ? Math.min(1, value.percent / (state.VolumeMaxPercent || 100)) : 0 })
      ]);
      if (surface.shown) await motion.play('change');
    }
    if (wanted && visible() && !surface.shown) await surface.show();
  }
  return { audio,
    onState: value => {
      state = value; audio.configure(value);
      if (!started && value.Active && (value.VolumeButtonsEnabled !== false || value.VolumeIndicatorEnabled !== false)) { started = true; audio.start(); }
      if (!visible()) { wanted = false; clearTimeout(timer); }
      return enqueue(reconcile);
    },
    onButton: event => {
      if (!state.Active || state.VolumeButtonsEnabled === false || (state.ScreenState !== 'unlocked' && state.VolumeWhileLocked === false)) return;
      if (event.State !== 'pressed' && event.State !== 'repeat') return;
      if (event.Button === 'volume-up') audio.adjust(1);
      else if (event.Button === 'volume-down') audio.adjust(-1);
    },
    get window() { return surface?.shown ? surface.win : undefined; }
  };
}

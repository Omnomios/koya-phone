import { session as Bus } from 'Module/dbus';
import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { call } from './session.js';
import { icon, text } from './touch-ui.js';
import { haptic } from './haptics.js';
import { CREAM, ORANGE, CARD, TRACK, RADIUS, TYPE } from './theme.js';

export function createBrightness(allowed) {
  let state = {}, value = { Available: false, Percent: -1 }, target, writing = false, reading = false, dragging = false;
  let binding, generation = 0, painted, queue = Promise.resolve();
  const paint = () => {
    const current = binding, token = generation;
    queue = queue.then(async () => {
      if (!current || token !== generation) return;
      const percent = value.Available ? Math.max(0, Math.min(100, value.Percent)) : 0;
      const key = value.Available + ':' + percent;
      if (key === painted) return;
      painted = key;
      await Promise.all([
        UI.setTextString(current.win, current.label, value.Available ? percent + '%' : '—'),
        UI.setScale(current.win, current.fill, { x: percent / 100, y: 1 }),
        UI.setPosition(current.win, current.thumb, { x: current.travel * percent / 100, y: 0 }),
        UI.setEnabled(current.win, current.thumb, value.Available)
      ]);
    }).catch(error => Log.error('Brightness UI: ' + error));
    return queue;
  };
  const refresh = async () => {
    if (reading || writing) return;
    reading = true;
    try { value = await call('GetBrightness'); await paint(); }
    catch (error) { Log.error('Brightness read: ' + error); }
    finally { reading = false; }
  };
  const pump = async () => {
    if (writing) return;
    writing = true;
    try {
      while (target !== undefined && allowed()) {
        const percent = target; target = undefined;
        const actual = await call('SetBrightness', 'u', percent);
        // Keep a newer drag position on screen while its write is pending.
        if (target === undefined) { value = actual; await paint(); }
      }
    } catch (error) {
      target = undefined;
      Log.error('Brightness: ' + error);
      writing = false; await refresh();
    } finally { writing = false; }
  };
  const setPercent = percent => {
    if (!allowed() || !value.Available) return;
    percent = Math.max(state.BrightnessMinPercent || 5, Math.min(100, Math.round(percent)));
    if (percent === value.Percent) return;
    target = percent; value = { ...value, Percent: percent }; paint(); pump();
  };
  return {
    start: async () => {
      Bus.onSignal(event => {
        if (event.interface === 'org.koya.Shell1' && event.member === 'BrightnessChanged' && allowed() && binding) refresh();
      });
      await Bus.addMatch("type='signal',sender='org.koya.Shell1',interface='org.koya.Shell1',member='BrightnessChanged'");
    },
    onState: next => { state = next; if (!allowed()) { dragging = false; target = undefined; } },
    refresh, setPercent,
    get value() { return value; },
    get busy() { return reading || writing; },
    attach: async (win, parent, width) => {
      ++generation; binding = undefined; painted = undefined;
      const card = await UI.createElement(win, {
        renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.surface, cornerResolution: 16 },
        layout: { type: 'row', gap: 12, padding: { l: 16, r: 8, t: 0, b: 0 }, alignItems: 'center' },
        item: { size: { x: width, y: 72 } }, contentAlign: 'fill'
      });
      await UI.attach(win, parent, card);
      await icon(win, card, '/rom/assets/status/brightness.png', 26, 36, 72);
      const sliderWidth = width - 24 - 36 - 24 - 52, travel = sliderWidth - 28;
      const seek = point => setPercent((point.x - 14) / travel * 100);
      const slider = await UI.createElement(win, {
        renderable: { type: 'box', colour: [0, 0, 0, 0] }, item: { size: { x: sliderWidth, y: 72 } }, contentAlign: 'fill',
        onMouseDown: (_, point) => { if (value.Available && allowed()) { dragging = true; haptic(); seek(point); } },
        onMouseMove: (_, point) => { if (dragging) seek(point); },
        onMouseUp: (_, point) => { if (dragging) seek(point); dragging = false; },
        onMouseExit: () => { dragging = false; }
      });
      await UI.attach(win, card, slider);
      await UI.setElementId(win, slider, 'brightness-slider');
      const rail = await UI.createElement(win, {
        layout: { type: 'column', justifyContent: 'center', alignItems: 'center' },
        item: { size: { x: sliderWidth, y: 72 } }
      });
      await UI.attach(win, slider, rail);
      const track = await UI.createElement(win, {
        renderable: { type: 'box', colour: TRACK, cornerRadius: 1, cornerResolution: 16 },
        clipToBounds: true, clipToMask: true, item: { size: { x: travel, y: 6 } }, contentAlign: 'fill'
      });
      await UI.attach(win, rail, track);
      const fill = await UI.createElement(win, {
        renderable: { type: 'box', colour: ORANGE, origin: { x: 0, y: 0.5 }, scale: { x: 0, y: 1 } },
        item: { size: { x: travel, y: 6 } }, contentAlign: 'fill'
      });
      await UI.attach(win, track, fill);
      // A flow container gives the thumb a real 28px slot. Children of a
      // layout-less element otherwise inherit the slider's full bounds.
      const thumbRail = await UI.createElement(win, {
        layout: { type: 'column', justifyContent: 'center', alignItems: 'start' },
        item: { size: { x: sliderWidth, y: 72 } }
      });
      await UI.attach(win, slider, thumbRail);
      const thumb = await UI.createElement(win, {
        renderable: { type: 'box', colour: CREAM, cornerRadius: RADIUS.control, cornerResolution: 16 },
        item: { size: { x: 28, y: 28 } }, contentAlign: 'fill'
      });
      await UI.attach(win, thumbRail, thumb);
      await UI.setElementId(win, thumb, 'brightness-thumb');
      const label = await text(win, card, '—', TYPE.caption + 1, 52, 72);
      await UI.setElementId(win, label, 'brightness-percent');
      binding = { win, slider, fill, thumb, label, travel }; await paint();
    }
  };
}

import * as UI from 'Helix/UserInterface';

// Positive-time first keys let Koya capture the current value at t=0. A new
// gesture can interrupt a clip without jumping back to an authored start pose.
export async function clips(win, element, definitions) {
  const ids = {};
  for (const [name, frames] of Object.entries(definitions)) {
    ids[name] = await UI.addAnimation(win, element, frames);
  }
  return {
    ids,
    play: name => UI.startAnimation(win, element, ids[name]),
    onEnd: (name, callback) => UI.onAnimationEnd(win, element, ids[name], callback)
  };
}

export async function buttonMotion(win, element, side, index) {
  // Centre the visual scale. Layout and its hit-test bounds remain unchanged.
  const pose = (scale = 1, y = 0, x = 0) => ({
    scale: { x: scale, y: scale },
    position: { x: side * (1 - scale) / 2 + x, y: side * (1 - scale) / 2 + y }
  });
  const delay = index * 0.055;
  const start = { opacity: 0, ...pose(0.98, side * 0.1125) };
  return clips(win, element, {
    enter: [
      { time: 0, ...start },
      ...(delay ? [{ time: delay, ...start }] : []),
      { time: delay + 0.32, opacity: 1, ...pose(), ease: 'outCubic' }
    ],
    press: [{ time: 0.075, opacity: 1, ...pose(0.95, 3), ease: 'outQuad' }],
    release: [
      { time: 0.105, opacity: 1, ...pose(1.018, -2), ease: 'outCubic' },
      { time: 0.26, opacity: 1, ...pose(), ease: 'outCubic' }
    ],
    settle: [{ time: 0.14, opacity: 1, ...pose(), ease: 'outCubic' }],
    focus: [{ time: 0.14, opacity: 1, ...pose(1.018), ease: 'outCubic' }],
    notice: [
      { time: 0.055, opacity: 1, ...pose(1, 0, -6), ease: 'outQuad' },
      { time: 0.12, opacity: 1, ...pose(1, 0, 5), ease: 'inOutQuad' },
      { time: 0.19, opacity: 1, ...pose(1, 0, -2), ease: 'inOutQuad' },
      { time: 0.27, opacity: 1, ...pose(), ease: 'outCubic' }
    ]
  });
}

import * as UI from 'Helix/UserInterface';
import { clips } from './motion.js';
import { swipeThreshold } from './swipe.js';

// Two visual layers share the gesture but keep their own animation channels.
// Centring compensation keeps the wallpaper's centre fixed while it scales.
export async function lockMotion(win, wallpaper, content, size) {
  const zoomPose = scale => ({
    scale: { x: scale, y: scale },
    position: { x: size.x * (1 - scale) / 2, y: size.y * (1 - scale) / 2 }
  });
  const background = await clips(win, wallpaper, {
    blank: [{ time: 0, opacity: 0, ...zoomPose(1) }],
    enter: [{ time: 0, opacity: 0, ...zoomPose(1) },
      { time: 0.32, opacity: 1, ...zoomPose(1), ease: 'outCubic' }],
    settle: [{ time: 0.24, opacity: 1, ...zoomPose(1), ease: 'outCubic' }],
    drag: [{ time: 0.045, ...zoomPose(1) }],
    leave: [{ time: 0.25, ...zoomPose(1.035), ease: 'outCubic' }]
  });
  const foreground = await clips(win, content, {
    blank: [{ time: 0, opacity: 0, position: { x: 0, y: 0 } }],
    enter: [{ time: 0, opacity: 0, position: { x: 0, y: 18 } },
      { time: 0.32, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }],
    settle: [{ time: 0.24, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }],
    drag: [{ time: 0.045, position: { x: 0, y: 0 } }],
    leave: [{ time: 0.25, opacity: 0, position: { x: 0, y: -70 }, ease: 'outCubic' }]
  });
  const play = async name => {
    await background.play(name);
    await foreground.play(name);
  };
  return {
    play,
    resize: () => UI.updateAnimation(win, wallpaper, background.ids.leave,
      [{ time: 0.25, opacity: 1, ...zoomPose(1.035), ease: 'outCubic' }]),
    async drag(distance) {
      const travel = Math.max(0, Math.min(size.y * 0.6, distance));
      const progress = Math.min(1, travel / swipeThreshold(size.y));
      await UI.updateAnimation(win, wallpaper, background.ids.drag,
        [{ time: 0.045, opacity: 1, ...zoomPose(1 + progress * 0.035), ease: 'outQuad' }]);
      await UI.updateAnimation(win, content, foreground.ids.drag,
        [{ time: 0.045, position: { x: 0, y: -travel }, opacity: Math.max(0.35, 1 - travel / size.y), ease: 'outQuad' }]);
      await play('drag');
    },
    async leave(distance) {
      const travel = Math.max(0, Math.min(size.y * 0.6, distance));
      await UI.updateAnimation(win, content, foreground.ids.leave,
        [{ time: 0.25, opacity: 0, position: { x: 0, y: -travel - 70 }, ease: 'outCubic' }]);
      await play('leave');
    }
  };
}

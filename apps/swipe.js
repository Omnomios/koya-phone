// Gesture decisions use fixed window coordinates, independent of visual motion.
export function swipeGesture(height) {
  const threshold = swipeThreshold(height);
  let start;
  return {
    down(point) { start = point; },
    move(point) { return start ? Math.max(0, start.y - point.y) : null; },
    up(point) {
      if (!start) return false;
      const dy = start.y - point.y;
      const dx = Math.abs(start.x - point.x);
      start = null;
      return dy >= threshold && dx < dy * 0.75;
    },
    cancel() { start = null; }
  };
}
export const swipeThreshold = height => Math.min(120, Math.max(50, height * 0.14));

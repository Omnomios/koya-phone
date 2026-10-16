// Feedback belongs to the held control, even when a finger leaves its bounds.
// Independent contacts must not release one another's animation or key repeat.
export function pressFeedback({ start, release, cancel = release }) {
  const held = new Set();
  let cancelled = false;
  return event => {
    if (event.phase === 'start') {
      if (held.has(event.interactionId)) return;
      held.add(event.interactionId);
      if (held.size === 1) return start?.(event);
    } else if (event.phase === 'end' || event.phase === 'cancel') {
      if (!held.delete(event.interactionId)) return;
      cancelled ||= event.phase === 'cancel';
      if (!held.size) {
        const finish = cancelled ? cancel : release;
        cancelled = false;
        return finish?.(event);
      }
    }
  };
}

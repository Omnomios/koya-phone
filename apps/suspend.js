// Koya owns the automatic sleep policy. Native code only relays the request
// and elogind lifecycle; no polling or retries while the screen stays off.
export function suspendPolicy(request, report) {
  let timer, generation = 0, seconds = 0, attempted = false;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined; ++generation;
  };
  return {
    onState(state) {
      const delay = Math.max(0, Math.min(86400, Number(state.IdleSuspendSeconds) || 0));
      if (delay !== seconds) { cancel(); seconds = delay; attempted = false; }
      if (!state.Active || state.ScreenState !== 'off') {
        cancel(); attempted = false; return;
      }
      if (!seconds || !state.DisplayOff || state['lock-screenStatus'] !== 'ready' ||
          state.PreparingForSleep || state.SuspendPending || state.PowerMenuState === 'pending') {
        cancel(); return;
      }
      if (attempted || timer !== undefined) return;
      const token = generation;
      timer = setTimeout(async () => {
        timer = undefined;
        if (token !== generation) return;
        attempted = true;
        try { await request(); }
        catch (error) { report('Automatic suspend: ' + error); }
      }, seconds * 1000);
    },
    dispose: cancel
  };
}

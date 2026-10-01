export function lockController({ authenticate, unlock, onStatus = () => {}, now = () => Date.now() }) {
  let state = {}, attempt = 0, busy = false, failures = 0, retryAt = 0;
  return {
    update(next) {
      if (next.LockGeneration !== state.LockGeneration || next.ScreenState !== 'locked' || !next.Active) { ++attempt; busy = false; onStatus(''); }
      state = next;
    },
    get busy() { return busy; },
    async submit(answer) {
      if (busy || !state.Active || state.ScreenState !== 'locked' || !state.SecureLocked) return false;
      if (now() < retryAt) { onStatus('Try again in a moment'); return false; }
      busy = true; const token = ++attempt, generation = state.LockGeneration;
      onStatus('Checking…');
      try {
        if (typeof answer === 'function') answer = await answer();
        if (token !== attempt || !state.Active || state.ScreenState !== 'locked' || generation !== state.LockGeneration) { answer = ''; return false; }
        if (!answer) throw new Error('Empty credential');
        const result = await authenticate(answer, state.UserName);
        if (result?.ok !== true) throw new Error('Authentication failed');
        answer = '';
        if (token !== attempt || !state.Active || state.ScreenState !== 'locked' || generation !== state.LockGeneration) return false;
        await unlock(generation);
        failures = 0; onStatus(''); return true;
      } catch (_) {
        answer = '';
        if (token === attempt) { retryAt = now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)); onStatus('Incorrect password or PIN'); }
        return false;
      } finally { if (token === attempt) busy = false; }
    },
    cancel() { ++attempt; busy = false; }
  };
}

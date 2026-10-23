import { Bus, fixture, coordinator, stop, call, state, waitState, wait, sleep, assert, equal, denied, key, action, testCall, run } from './check.js';
const login = (method, value) => Bus.call('org.freedesktop.login1', '/org/freedesktop/login1', 'org.koya.Test.Sleep', method, 'b', value);
const inhibitors = () => Bus.callComplex('org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'ListInhibitors', '');
const blocks = async () => (await inhibitors()).filter(item => item[3] === 'block');
const power = async () => { await key(116, 1); await key(116, 0); };
export default run(async () => {
  fixture('sleep');
  await wait(async () => { await inhibitors(); return true; });
  const process = coordinator();
  await waitState(s => s.Active && s['top-barStatus'] === 'ready');
  equal((await state()).LockGraceSeconds, 60);
  await call('SetSetting', 'ss', 'LockGraceSeconds', '2');
  await power();
  let off = await waitState(s => s.ScreenState === 'off' && s.SecureLocked);
  assert(!off.AuthenticationRequired, 'Screen-off required authentication immediately');
  await denied(() => call('BeginGraceUnlock', 'u', off.LockGeneration));
  await power(); await waitState(s => s.ScreenState === 'locked');
  await action('GraceUnlock', 'lock_screen');
  await waitState(s => s.ScreenState === 'unlocked' && s['lock-screenPid'] === 0);
  await sleep(2100);
  assert(!(await state()).AuthenticationRequired, 'Cancelled grace timer locked a resumed session');

  await power(); await waitState(s => s.ScreenState === 'off' && s.SecureLocked);
  await waitState(s => s.AuthenticationRequired, 'Grace deadline did not require authentication');
  await power(); await denied(() => action('GraceUnlock', 'lock_screen'));
  await action('Unlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);

  await power(); await waitState(s => s.ScreenState === 'off' && s.SecureLocked);
  await call('Lock'); await waitState(s => s.ScreenState === 'locked' && s.AuthenticationRequired);
  await denied(() => action('GraceUnlock', 'lock_screen'));
  await action('Unlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);

  // A forced lock during the compositor unlock handshake must win.
  await power(); await waitState(s => s.ScreenState === 'off' && s.SecureLocked);
  await power(); await action('BeginGraceUnlock', 'lock_screen'); await call('Lock');
  await action('CompleteUnlock', 'lock_screen');
  await waitState(s => s.ScreenState === 'locked' && s.AuthenticationRequired && s.SecureLocked);
  await action('Unlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);

  // The deadline can expire between authorization and releasing the Wayland lock.
  await call('SetSetting', 'ss', 'LockGraceSeconds', '1');
  await power(); await waitState(s => s.ScreenState === 'off' && s.SecureLocked);
  await power(); await action('BeginGraceUnlock', 'lock_screen');
  await waitState(s => s.AuthenticationRequired);
  await action('CompleteUnlock', 'lock_screen');
  await waitState(s => s.ScreenState === 'locked' && s.AuthenticationRequired && s.SecureLocked);
  await denied(() => action('GraceUnlock', 'lock_screen'));
  await action('Unlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);
  await call('SetSetting', 'ss', 'LockGraceSeconds', '2');

  // External suspend preserves the original grace deadline, without restarting it on resume.
  await login('Prepare', true); await waitState(s => s.PreparingForSleep && s.SecureLocked);
  assert(!(await state()).AuthenticationRequired);
  await login('Prepare', false); await waitState(s => !s.PreparingForSleep && s.ScreenState === 'locked');
  await action('GraceUnlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);
  await login('Prepare', true); await waitState(s => s.PreparingForSleep && s.SecureLocked);
  await sleep(2200); await login('Prepare', false);
  await waitState(s => !s.PreparingForSleep && s.AuthenticationRequired);
  await denied(() => action('GraceUnlock', 'lock_screen'));
  await action('Unlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);

  await sleep(800);
  await call('SetCaffeine', 'b', true);
  assert((await state()).CaffeineActive);
  const held = await blocks(); equal(held.length, 1); equal(held[0].slice(0, 4), ['idle:sleep', 'Koya phone', 'Caffeine keeps the phone awake', 'block']);
  await testCall('Idle'); assert((await state()).ScreenState === 'unlocked', 'Caffeine allowed automatic screen-off');
  await power(); off = await waitState(s => s.ScreenState === 'off' && s.SecureLocked);
  assert(!off.AuthenticationRequired && off.CaffeineActive, 'Caffeine blocked manual screen-off or forced a lock');
  await power(); await action('GraceUnlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);
  await call('Lock'); await waitState(s => s.AuthenticationRequired && s.SecureLocked);
  await denied(() => action('GraceUnlock', 'lock_screen'));
  await action('Unlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);
  await call('SetCaffeine', 'b', false); await wait(async () => (await blocks()).length === 0, 'Inhibitor FD was not released');

  await login('RejectInhibit', true); await denied(() => call('SetCaffeine', 'b', true));
  assert(!(await state()).CaffeineActive && !(await state()).CaffeinePending);
  await login('RejectInhibit', false);
  await testCall('Idle'); await waitState(s => s.ScreenState === 'off' && s.SecureLocked);
  assert(!(await state()).AuthenticationRequired, 'Idle screen-off skipped the grace period');
  await power(); await action('GraceUnlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);
  await login('HoldInhibit', true);
  const enabling = call('SetCaffeine', 'b', true).then(() => false, () => true);
  await waitState(s => s.CaffeinePending); await call('SetCaffeine', 'b', false);
  await login('HoldInhibit', false); assert(await enabling, 'Cancelled activation succeeded');
  await wait(async () => (await blocks()).length === 0, 'Cancelled activation leaked an inhibitor');

  await login('HoldInhibit', true);
  const interrupted = call('SetCaffeine', 'b', true).then(() => false, () => true);
  await waitState(s => s.CaffeinePending); await call('Lock');
  await waitState(s => s.SecureLocked && s.AuthenticationRequired);
  await login('HoldInhibit', false); assert(await interrupted, 'Locking did not cancel Caffeine activation');
  await wait(async () => (await blocks()).length === 0, 'Interrupted activation leaked an inhibitor');
  await denied(() => call('SetCaffeine', 'b', true));
  await action('Unlock', 'lock_screen'); await waitState(s => s['lock-screenPid'] === 0);

  await call('SetCaffeine', 'b', true); await login('Active', false);
  await waitState(s => !s.Active && !s.CaffeineActive);
  await wait(async () => (await blocks()).length === 0, 'Inactive session retained Caffeine');
  await login('Active', true); await waitState(s => s.Active);
  await call('SetCaffeine', 'b', true); await stop(process);
  await wait(async () => (await inhibitors()).length === 0, 'Shutdown leaked an inhibitor FD');
});

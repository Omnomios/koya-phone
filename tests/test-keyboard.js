import { Bus, Process, runtime, fixture, coordinator, call, state, waitState, wait, sleep, assert, denied, action, kill, stop, dead, run } from './check.js';
const keyboard = (method, signature = '', ...args) => Bus.call('sm.puri.OSK0', '/sm/puri/OSK0', 'org.koya.Test.Keyboard', method, signature, ...args);
const toggle = () => action('ToggleKeyboard', 'navigation');
const shown = () => waitState(s => s.KeyboardVisible && !s.KeyboardPending);
const hidden = () => waitState(async s => !s.KeyboardVisible && !s.KeyboardPending &&
  (await Bus.call('sm.puri.OSK0', '/sm/puri/OSK0', 'org.freedesktop.DBus.Properties', 'Get', 'ss', 'sm.puri.OSK0', 'Visible')) === 'false');
export default run(async () => {
  fixture('login'); const process = coordinator();
  let initial = await waitState(s => s.Active && s['navigationStatus'] === 'ready' && s['keyboardStatus'] === 'ready');
  const pid = initial['keyboardPid']; assert(initial.KeyboardAvailable && pid && !initial.KeyboardVisible, JSON.stringify(initial));
  await denied(() => call('ToggleKeyboard'));
  await toggle(); await shown(); await toggle(); await hidden();
  await keyboard('Visible', 'b', true); await shown(); await call('SwitchDesktop', 'u', 1); await hidden();
  await toggle(); await shown(); await call('ShowDesktopView', 's', 'apps'); await hidden();
  await keyboard('Visible', 'b', true); await hidden();
  await call('DismissDesktopView'); await toggle(); await shown();
  await call('ShowPowerMenu'); await hidden(); await waitState(s => s.PowerMenuState === 'open');
  await call('DismissPowerMenu'); await waitState(s => s.PowerMenuState === 'closed');
  await toggle(); await shown(); await call('Lock'); await hidden(); await waitState(s => s['lock-screenStatus'] === 'ready');
  await denied(toggle); await action('Unlock', 'lock_screen'); await waitState(s => s.ScreenState === 'unlocked');
  await keyboard('DelayNext'); await toggle(); await toggle(); await hidden();
  await keyboard('DelayNext'); await toggle(); await call('Lock'); await hidden(); await waitState(s => s['lock-screenStatus'] === 'ready');
  await action('Unlock', 'lock_screen'); await waitState(s => s.ScreenState === 'unlocked');
  await keyboard('FailNext'); await toggle(); await waitState(s => s.LastError.includes('Test keyboard rejected') && !s.KeyboardPending);
  await hidden(); await toggle(); await shown();
  await Process.exec("printf 'workspacev2>>1,1\\n' >> '" + runtime + "/events'"); await hidden();
  await kill(pid); const replacement = await waitState(s => s['keyboardPid'] !== pid && s['keyboardPid'] !== 0 && s['keyboardStatus'] === 'ready');
  await stop(process); await wait(() => dead(replacement['keyboardPid']), 'Keyboard survived coordinator shutdown');
});

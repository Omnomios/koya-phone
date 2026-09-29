import { Bus, Process, runtime, appRoot, fixture, coordinator, stop, call, state, waitState, wait, assert, equal, denied, login, action, read, run } from './check.js';
import { WALLPAPERS, wallpaperFrame } from '../apps/wallpapers.js';

export default run(async () => {
  fixture('login');
  await wait(async () => { await login(); return true; });
  Process.writeFileText(appRoot + '/session.conf', '[idle]\nlock-seconds=120\nlock-screen-seconds=30\n[volume]\nstep-percent=5\n');
  let process = coordinator();
  await waitState(s => s.Active && s['top-barStatus'] === 'ready');
  equal((await state()).Wallpaper, 'earthy-green');
  let changed = 0;
  Bus.onSignal(event => { if (event.interface === 'org.koya.Shell1' && event.member === 'StateChanged' && event.args[0].Wallpaper === 'tidal-blue') changed++; });
  await Bus.addMatch("type='signal',interface='org.koya.Shell1',member='StateChanged'");
  const set = (key, value) => call('SetSetting', 'ss', key, String(value));
  for (const wallpaper of WALLPAPERS) equal((await set('Wallpaper', wallpaper.id)).Wallpaper, wallpaper.id);
  await set('Wallpaper', 'tidal-blue');
  await wait(() => changed > 0, 'Wallpaper change was not broadcast');
  await set('IdleLockSeconds', 300);
  await set('VolumeButtonsEnabled', false);
  await set('VolumeIndicatorSide', 'right');
  await set('VolumeStepPercent', 10);
  await set('BrightnessMinPercent', 10);
  for (const [key, value] of [['Wallpaper', '../etc/passwd'], ['Wallpaper', 'missing'], ['IdleLockSeconds', -1],
    ['IdleLockSeconds', 86401], ['VolumeStepPercent', 26], ['VolumeStepPercent', '5.5'], ['BrightnessMinPercent', 0],
    ['VolumeButtonsEnabled', 'yes'], ['VolumeIndicatorSide', 'bottom'], ['Unknown', 1], ['VolumeMaxPercent', '999999999999999999999']]) {
    await denied(() => set(key, value));
  }
  const saved = await read(runtime + '/config/koya-shell/settings.conf');
  assert(saved.includes('wallpaper=tidal-blue') && saved.includes('buttons-enabled=false'), 'Selection was not saved');
  await call('Lock'); await waitState(s => s['lock-screenStatus'] === 'ready');
  await denied(() => set('Wallpaper', 'violet-dusk'));
  equal((await state()).Wallpaper, 'tidal-blue');
  await action('Unlock', 'lock_screen'); await waitState(s => s.ScreenState === 'unlocked');
  await login(false); await waitState(s => !s.Active);
  await denied(() => set('VolumeStepPercent', 5));
  await login(); await waitState(s => s.Active);
  // A disk failure must not change the live value or overwrite saved settings.
  await Process.exec('mv ' + runtime + '/config/koya-shell/settings.conf ' + runtime + '/config/koya-shell/saved.conf');
  Process.mkdir(runtime + '/config/koya-shell/settings.conf');
  await denied(() => set('VolumeStepPercent', 7));
  equal((await state()).VolumeStepPercent, 10);
  await Process.exec('rmdir ' + runtime + '/config/koya-shell/settings.conf && mv ' + runtime + '/config/koya-shell/saved.conf ' + runtime + '/config/koya-shell/settings.conf');
  await stop(process); process = coordinator();
  const restored = await waitState(s => s.Active && s['top-barStatus'] === 'ready');
  equal([restored.Wallpaper, restored.IdleLockSeconds, restored.VolumeButtonsEnabled, restored.VolumeIndicatorSide, restored.VolumeStepPercent, restored.BrightnessMinPercent],
    ['tidal-blue', 300, false, 'right', 10, 10]);
  equal(await read(appRoot + '/session.conf'), '[idle]\nlock-seconds=120\nlock-screen-seconds=30\n[volume]\nstep-percent=5\n', 'Base policy was changed');
  for (const wallpaper of WALLPAPERS) {
    for (const size of [{ x: 432, y: 910 }, { x: 910, y: 432 }]) {
      const { aabb } = wallpaperFrame(wallpaper, size);
      assert(aabb.min.x >= 0 && aabb.min.y >= 0 && aabb.max.x <= wallpaper.size.x && aabb.max.y <= wallpaper.size.y, 'Wallpaper crop exceeds the source');
      assert(Math.abs((aabb.max.x - aabb.min.x) / (aabb.max.y - aabb.min.y) - size.x / size.y) < 0.0001, 'Wallpaper was distorted');
    }
  }
});

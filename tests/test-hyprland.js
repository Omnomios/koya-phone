import { Bus, Process, root, appRoot, runtime, build, quote, spawn, fixture, stop, call, state, waitState, wait, sleep, assert, equal, denied, key, action, login, read, dead, kill, run } from './check.js';
import { createRotation } from '../apps/rotation.js';
const exec = command => Process.exec(command).catch(error => { throw new Error(command + ': ' + error); });
const path = runtime + '/koya-display.sock', metadata = runtime + '/koya-hyprland.state';
const on = async () => (await read(runtime + '/dpms')).trim() === '1';
const bridge = command => spawn(build + '/koya-hyprland-display-test', [appRoot, ...command]);
const ready = () => wait(() => Process.exists(metadata), 'Adapter failed to start');
const idlePid = async () => Number(await read(runtime + '/idle-pid'));
async function receive(client, length) {
  await wait(() => client.output.length >= length, 'Adapter packet timed out: ' + client.errorOutput, 1500);
  const data = client.output.slice(0, length); client.output = client.output.slice(length); return data;
}
async function packet(client, data) { client.write(data); return receive(client, 1); }
const emit = text => Process.exec('printf %s ' + quote(text) + ' >> ' + quote(runtime + '/events'));
export default run(async () => {
  // Leave a bound socket behind to exercise stale adapter recovery.
  const stale = spawn('socat', ['UNIX-LISTEN:' + path + ',socktype=5,unlink-close=0', 'STDIO']);
  await wait(() => Process.exists(path)); await stop(stale, 9);
  let process = bridge(['setpriv', '--pdeathsig', 'TERM', 'sleep', '86400']); await ready();
  const client = spawn('socat', ['STDIO', 'UNIX-CONNECT:' + path + ',socktype=5']);
  equal(await packet(client, '?'), '1'); equal(await packet(client, '0'), '0'); assert(!(await on()));
  equal(await packet(client, '?'), '0');
  for (const invalid of ['x', '00', 't 86401 1', 't -1 1', 't 1 4294967296', 't 1 2 extra']) equal(await packet(client, invalid), 'E', invalid);
  Process.writeFileText(runtime + '/reject-dpms', '1'); equal(await packet(client, '1'), 'E'); assert(!(await on()));
  await exec('rm -- ' + quote(runtime + '/reject-dpms'));
  const duplicate = spawn(build + '/koya-hyprland-display', [appRoot]);
  await wait(() => duplicate.code !== null); assert(duplicate.code !== 0, 'Duplicate adapter accepted');
  equal(await packet(client, '?'), '0'); equal(await packet(client, '1'), '1');
  equal(await packet(client, 't 1 10'), 't'); await sleep(600);
  equal(await packet(client, 't 1 11'), 't'); assert(!client.output, 'Early idle event');
  await sleep(500); assert(!client.output, 'Old idle generation survived rearm');
  equal(await receive(client, 4), 'T 11'); const oldIdle = await idlePid();
  equal(await packet(client, 't 0 12'), 't'); await wait(() => dead(oldIdle));
  equal(await packet(client, '0'), '0'); await stop(client); await wait(on);
  assert(await stop(process) === 0); assert(!Process.exists(path) && !Process.exists(metadata), 'Adapter state survived shutdown');
  fixture('login'); await wait(async () => { await login(); return true; });
  await applicationFixtures();
  process = bridge(['setpriv', '--pdeathsig', 'TERM', build + '/koya-session-test', appRoot, root + '/tests/fixtures/component-display.sh']);
  await waitState(s => s.Active && s['top-barStatus'] === 'ready');
  await sleep(1000); await kill(await idlePid(), 'USR2'); await sleep(1300);
  assert((await state()).ScreenState === 'unlocked', 'Idle reset failed');
  await waitState(async s => s.ScreenState === 'off' && s['lock-screenStatus'] === 'ready' && !(await on()));
  assert(!(await state()).LastError); await key(116, 1); await key(116, 0);
  await waitState(s => s.ScreenState === 'locked'); assert(await on());
  await waitState(s => s.ScreenState === 'off'); assert(!(await on()));
  await key(116, 1); await key(116, 0); await action('Unlock', 'lock_screen');
  await waitState(s => s.ScreenState === 'unlocked'); await waitState(s => s['navigationStatus'] === 'ready');
  assert(await stop(process) === 0);
  // Desktop assertions use a fresh session without the two-second idle policy.
  process = bridge(['setpriv', '--pdeathsig', 'TERM', 'env', 'KOYA_TEST_IDLE_LOCK_SECONDS=0', build + '/koya-session-test', appRoot, root + '/tests/fixtures/component-display.sh']);
  await waitState(s => s.Active && s['navigationStatus'] === 'ready');
  const apps = await call('GetApplications');
  assert(apps.some(app => app.id === 'koya-test.desktop'), JSON.stringify(apps));
  assert(!apps.some(app => app.id === 'koya-hidden.desktop'), 'Hidden application exposed');
  for (const [id, source] of [['koya-test.desktop', runtime + '/icons/koya-parent/scalable/apps/koya-test-icon.svg'], ['koya-file-icon.desktop', runtime + '/absolute.png']]) {
    const app = apps.find(entry => entry.id === id); assert(app, 'Missing icon application');
    const stamp = (await exec('stat -c ' + quote('%Y:%y:%s') + ' -- ' + quote(source))).stdout.trim();
    const parts = stamp.split(':');
    const seconds = parts[0], nanoseconds = stamp.match(/\.(\d{9}) /)[1], size = parts[parts.length - 1];
    const identity = source + ':' + seconds + ':' + Number(nanoseconds) + ':' + size;
    const digest = (await exec('printf %s ' + quote(identity) + ' | sha256sum')).stdout.split(' ')[0];
    const filename = 'koya-app-icon-' + digest + '.png'; equal(app.icon, '/rom/' + filename);
    const png = (await exec('od -An -tu1 -N24 -- ' + quote(runtime + '/koya/icons/' + filename))).stdout.trim().split(/\s+/).map(Number);
    equal(png.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
    equal(png.slice(16, 24), [0, 0, 0, 160, 0, 0, 0, 160], 'Icon size');
  }
  equal(JSON.parse((await call('GetDesktopState')).activeworkspace).id, 1);
  const largeClient = { address: '0xabc', title: 'Window title '.repeat(7000) };
  Process.writeFileText(runtime + '/clients', JSON.stringify([largeClient]));
  equal(JSON.parse((await call('GetDesktopState')).clients), [largeClient], 'Large compositor reply was truncated');
  Process.writeFileText(runtime + '/clients', '[]');
  const events = []; Bus.addMatch("type='signal',interface='org.koya.Shell1',member='DesktopChanged'");
  Bus.onSignal(sig => { if (sig.member === 'DesktopChanged') events.push(sig); }); await call('GetState');
  await emit('work'); await sleep(30); await emit('spacev2>>2,2\n'); await wait(() => events.length > 0, 'Fragmented compositor event lost');
  await call('ShowDesktopView', 's', 'apps'); const drawer = await waitState(s => s['navigationStatus'] === 'ready' && s.DesktopView === 'apps');
  assert(!('desktop-viewPid' in drawer)); await call('ShowDesktopView', 's', 'desktops'); equal((await state())['navigationPid'], drawer['navigationPid']);
  const launch = id => Bus.call('org.koya.Test.navigation', '/org/koya/Test/Component', 'org.koya.Test.Component', 'Launch', 'su', id, 2);
  await denied(() => launch('missing.desktop'));
  for (const [method, sig, args] of [['LaunchApplication', 'su', ['koya-test.desktop', 2]], ['SwitchDesktop', 'u', [0]], ['FocusWindow', 's', ['0x12;quit']], ['CloseWindow', 's', ['class:.*']]]) await denied(() => call(method, sig, ...args));
  await launch('koya-test.desktop'); equal(Number(await read(runtime + '/workspace')), 2);
  assert((await read(runtime + '/commands')).includes(quote(appRoot + '/build/koya-launch-app') + ' ' + quote(runtime + '/applications/koya-test.desktop')), 'Launch command did not use the desktop entry');
  equal((await state()).DesktopView, 'desktops', 'Launch prematurely dismissed feedback');
  await call('FocusWindow', 's', '0xabc'); const hidden = await waitState(s => s.DesktopView === 'closed');
  equal(hidden['navigationPid'], drawer['navigationPid']); equal(hidden['navigationStatus'], 'ready');
  await call('ShowDesktopView', 's', 'desktops'); equal((await state())['navigationPid'], drawer['navigationPid']);
  await call('DismissDesktopView'); await call('SwitchDesktop', 'u', 1); equal(Number(await read(runtime + '/workspace')), 1);
  await call('ShowDesktopView', 's', 'desktops'); await call('SwitchDesktop', 'u', 1);
  equal(Number(await read(runtime + '/workspace')), 1); equal((await state()).DesktopView, 'closed');
  await call('FocusWindow', 's', '0xabc'); await call('CloseWindow', 's', '0xabc');
  fixture('sensors');
  await wait(async () => { await Bus.call('org.koya.Test.Sensor', '/net/hadess/SensorProxy', 'org.koya.Test.Sensor', 'Counts'); return true; });
  const rotation = createRotation('DSI-1');
  await rotation.onState({ Active: true, ScreenState: 'unlocked', AutoRotateEnabled: true });
  await rotation.start();
  await Bus.call('org.koya.Test.Sensor', '/net/hadess/SensorProxy', 'org.koya.Test.Sensor', 'Orientation', 's', 'left-up');
  await wait(async () => Number(await read(runtime + '/transform')) === 1, 'Native Hyprland module did not rotate the output');
  await rotation.dispose();
  await call('ShowPowerMenu'); await waitState(s => s.PowerMenuState === 'open'); assert(await on()); assert(!(await state()).LastError);
  await denied(() => call('SwitchDesktop', 'u', 2));
  const current = await state(), children = ['wallpaper', 'top-bar', 'power-menu', 'navigation'].map(name => current[name + 'Pid']).filter(Boolean);
  // Closing event peers simulates compositor exit without touching a desktop.
  await exec('pkill -TERM -f ' + quote('^tail -c \\+1 -f -s .02 ' + runtime + '/events$'));
  await wait(() => process.code !== null, 'Adapter did not handle compositor exit'); equal(process.code, 0);
  await wait(async () => (await Promise.all(children.map(dead))).every(Boolean));
  assert(await on()); assert(!Process.exists(path) && !Process.exists(metadata));
});
async function applicationFixtures() {
  Process.mkdir(runtime + '/applications');
  for (const [name, extra] of [['koya-test', 'Icon=koya-test-icon\n'], ['koya-hidden', 'NoDisplay=true\n']]) {
    Process.writeFileText(runtime + '/applications/' + name + '.desktop', '[Desktop Entry]\nType=Application\nName=' + name + '\nExec=/bin/true\n' + extra);
  }
  for (const [theme, inherits] of [['koya-test', 'Inherits=koya-parent\n'], ['koya-parent', '']]) {
    const directory = runtime + '/icons/' + theme;
    await exec('mkdir -p -- ' + quote(directory + '/scalable/apps'));
    Process.writeFileText(directory + '/index.theme', '[Icon Theme]\nName=Test\nDirectories=scalable/apps\n' + inherits + '[scalable/apps]\nSize=64\nType=Scalable\nMinSize=16\nMaxSize=256\n');
  }
  Process.writeFileText(runtime + '/icons/koya-parent/scalable/apps/koya-test-icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#ff0000"/></svg>');
  await exec('cp -- ' + quote(root + '/assets/power-menu/power-off.png') + ' ' + quote(runtime + '/absolute.png'));
  Process.writeFileText(runtime + '/applications/koya-file-icon.desktop', '[Desktop Entry]\nType=Application\nName=File icon\nExec=/bin/true\nIcon=' + runtime + '/absolute.png\n');
}

import { Bus, fixture, wait, sleep, assert, equal, run } from './check.js';
import { createRotation } from '../apps/rotation.js';

const control = (method, signature = '', ...args) => Bus.call(
  'org.koya.Test.Sensor', '/net/hadess/SensorProxy', 'org.koya.Test.Sensor', method, signature, ...args);
const counts = () => control('Counts');
export default run(async () => {
  const output = { name: 'DSI-1', width: 1080, height: 2280, refreshRate: 60, x: 10, y: 20, scale: 2, transform: 0 };
  const writes = [];
  let blockRead, reads = 0, blockTransition, transitions = 0;
  const rotation = createRotation(output.name, { transition: async apply => {
    ++transitions;
    if (blockTransition) { const waitFor = blockTransition; blockTransition = undefined; await waitFor; }
    return apply();
  }, exec: async command => {
    if (command === 'hyprctl -j monitors') {
      ++reads;
      if (blockRead) { const waitFor = blockRead; blockRead = undefined; await waitFor; }
      return { stdout: JSON.stringify([output]) };
    }
    assert(command.startsWith("hyprctl keyword monitor 'DSI-1,1080x2280@60,10x20,2,transform,"), 'Rotation changed the mode, position or scale');
    output.transform = Number(command.slice(-2, -1)); writes.push(output.transform);
    return { stdout: 'ok\n' };
  } });
  let state = { Active: true, DisplayOff: false, ScreenState: 'unlocked', AutoRotateEnabled: true };
  const configure = async next => { state = { ...state, ...next }; await rotation.onState(state); };
  const orient = value => control('Orientation', 's', value);
  const expect = transform => wait(() => output.transform === transform, 'Orientation did not reach compositor');
  const released = () => wait(async () => !(await counts()).Claimed, 'Accelerometer was not released');
  const claimed = () => wait(async () => (await counts()).Claimed, 'Accelerometer was not claimed');
  try {
    await configure({}); await rotation.start(); await sleep(300);
    equal(writes, [], 'Missing sensor service caused rotation');
    fixture('sensors'); await wait(async () => { await counts(); return true; });
    await claimed(); await sleep(300); equal(writes, [], 'Normal orientation was applied redundantly');
    for (const [name, transform] of [['left-up', 1], ['bottom-up', 2], ['right-up', 3], ['normal', 0]]) {
      await orient(name); await expect(transform);
    }
    equal(writes, [1, 2, 3, 0]);
    await orient('left-up'); await sleep(650);
    equal(output.transform, 0, 'Rotation happened before the phone settled');
    await orient('undefined'); await sleep(500);
    await orient('left-up'); await sleep(650);
    equal(output.transform, 0, 'An undefined reading did not reset the settling period');
    await orient('normal'); await sleep(1100);
    await orient('normal'); await orient('undefined'); await sleep(400);
    equal(writes, [1, 2, 3, 0], 'Duplicate or undefined orientation rotated the screen');
    await orient('left-up'); await sleep(650); await orient('right-up'); await sleep(650);
    equal(output.transform, 0, 'A changing orientation did not restart the settling period');
    await expect(3);
    equal(writes, [1, 2, 3, 0, 3], 'A quick turn applied an intermediate orientation');
    await configure({ AutoRotateEnabled: false }); await released();
    await orient('left-up'); await sleep(350); equal(output.transform, 3, 'Orientation lock changed the screen');
    await configure({ AutoRotateEnabled: true }); await claimed(); await expect(1);
    await configure({ ScreenState: 'off', DisplayOff: true }); await released();
    await orient('bottom-up'); await sleep(350); equal(output.transform, 1, 'Screen-off sensor update rotated the screen');
    await configure({ ScreenState: 'locked', DisplayOff: false }); await claimed(); await expect(2);
    await configure({ PreparingForSleep: true }); await released();
    await configure({ PreparingForSleep: false }); await claimed();
    await control('Available', 'b', false); await released();
    await control('Available', 'b', true); await claimed();
    await configure({ Active: false }); await released();
    await configure({ Active: true }); await claimed();
    const beforeRestart = (await counts()).Claims;
    await control('Drop'); await sleep(100); await orient('right-up');
    await control('Own'); await claimed(); await expect(3);
    equal((await counts()).Claims, beforeRestart + 1, 'Proxy restart was not reclaimed exactly once');
    await configure({ AutoRotateEnabled: false }); await released();
    await control('Reject', 'b', true); await configure({ AutoRotateEnabled: true }); await sleep(350);
    assert(!(await counts()).Claimed, 'Denied claim was treated as successful');
    await configure({ AutoRotateEnabled: false }); await control('Reject', 'b', false);
    await configure({ AutoRotateEnabled: true }); await claimed();
    // A new sensor sample must cancel a stale transform even while hyprctl is
    // blocked. Returning to the same position still needs a fresh settle time.
    let unblockSample;
    blockRead = new Promise(resolve => { unblockSample = resolve; });
    const beforeRead = reads;
    await orient('normal'); await wait(() => reads > beforeRead);
    await orient('left-up'); await orient('normal'); await sleep(150);
    unblockSample(); await sleep(400);
    equal(output.transform, 3, 'A stale compositor query skipped the fresh settling period');
    await expect(0);
    await orient('right-up'); await expect(3);
    let unblock;
    blockRead = new Promise(resolve => { unblock = resolve; });
    const beforeLockRead = reads;
    await orient('normal'); await wait(() => reads > beforeLockRead);
    const pending = configure({ AutoRotateEnabled: false });
    unblock(); await pending; await released();
    equal(output.transform, 3, 'A pending rotation escaped orientation lock');
    await configure({ AutoRotateEnabled: true }); await claimed(); await expect(0);
    let unblockFade;
    blockTransition = new Promise(resolve => { unblockFade = resolve; });
    const beforeFade = transitions;
    await orient('left-up'); await wait(() => transitions > beforeFade);
    const lockDuringFade = configure({ AutoRotateEnabled: false });
    unblockFade(); await lockDuringFade; await released();
    equal(output.transform, 0, 'Orientation lock during the fade still rotated the screen');
    await rotation.dispose(); await released();
    const before = writes.length; await orient('left-up'); await sleep(350);
    equal(writes.length, before, 'Disposed rotation subscription remained active');
  } finally { await rotation.dispose(); }
});

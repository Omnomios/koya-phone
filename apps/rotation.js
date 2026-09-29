import { system as Bus } from 'Module/dbus';
import * as Process from 'Module/process';
import * as Log from 'Helix/Log';

const SENSOR = 'net.hadess.SensorProxy', PATH = '/net/hadess/SensorProxy';
const transforms = { normal: 0, 'left-up': 1, 'bottom-up': 2, 'right-up': 3 };
const SETTLE_MS = 1000;
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

// The top bar owns this subscription in the active graphical session. The
// sensor proxy handles the device mount matrix and orientation detection.
export function createRotation(display, { exec = command => Process.exec(command), transition = apply => apply() } = {}) {
  let state = {}, available = false, orientation, owner = false, claimed = false;
  let started = false, closed = false, claimFailed = false, generation = 0, serviceGeneration = 0, timer, target;
  let queue = Promise.resolve();
  const wanted = () => started && !closed && owner && available && state.Active &&
    state.AutoRotateEnabled !== false && !state.DisplayOff && state.ScreenState !== 'off' && !state.PreparingForSleep;
  const cancel = () => { clearTimeout(timer); timer = undefined; target = undefined; };
  const enqueue = job => {
    queue = queue.then(job).catch(error => Log.error('Auto-rotate: ' + error));
    return queue;
  };
  const update = properties => {
    const nextAvailable = 'HasAccelerometer' in properties ? properties.HasAccelerometer === true : available;
    const nextOrientation = 'AccelerometerOrientation' in properties ? properties.AccelerometerOrientation : orientation;
    if (nextAvailable === available && nextOrientation === orientation) return;
    if (nextAvailable !== available) claimFailed = false;
    available = nextAvailable; orientation = nextOrientation;
    ++generation; cancel();
  };
  const read = async () => {
    const token = serviceGeneration, sample = generation;
    const properties = await Bus.call(SENSOR, PATH, 'org.freedesktop.DBus.Properties', 'GetAll', 's', SENSOR);
    if (token !== serviceGeneration || sample !== generation) return;
    update(properties);
  };
  const schedule = () => {
    const transform = transforms[orientation];
    if (!wanted() || !claimed || typeof transform !== 'number') { cancel(); return; }
    if (timer && target === transform) return;
    cancel(); target = transform;
    const token = generation;
    // Require a full second in the same orientation. Passing through another
    // position or an undefined reading starts the settling period again.
    timer = setTimeout(() => {
      timer = undefined; target = undefined;
      enqueue(async () => {
        const valid = () => wanted() && claimed && generation === token && transforms[orientation] === transform;
        if (!valid()) return;
        const result = await exec('hyprctl -j monitors');
        const output = JSON.parse(result.stdout).find(value => value.name === display);
        if (!valid()) return;
        if (!output) throw new Error('Display is unavailable');
        if (output.transform === transform) return;
        // Preserve the current physical mode, position and scale. A transform-
        // only monitor rule is not supported by the pinned Hyprland releases.
        const rule = [output.name, output.width + 'x' + output.height + '@' + output.refreshRate,
          output.x + 'x' + output.y, output.scale, 'transform', transform].join(',');
        await transition(async () => {
          if (!valid()) return false;
          const reply = await exec('hyprctl keyword monitor ' + quote(rule));
          if (reply.code || reply.exitCode || reply.stdout.trim() !== 'ok') throw new Error('Compositor rejected rotation');
          return true;
        });
      });
    }, SETTLE_MS);
  };
  const reconcile = async () => {
    if (!wanted()) {
      cancel();
      if (claimed) {
        claimed = false;
        if (owner) await Bus.call(SENSOR, PATH, SENSOR, 'ReleaseAccelerometer');
      }
      return;
    }
    if (!claimed && !claimFailed) {
      const token = serviceGeneration;
      try {
        await Bus.call(SENSOR, PATH, SENSOR, 'ClaimAccelerometer');
        if (token !== serviceGeneration) return;
        claimed = true;
        // Claim starts sampling; also pick up an already known orientation.
        await read();
      } catch (error) {
        if (token === serviceGeneration) { claimFailed = true; cancel(); throw error; }
        return;
      }
    }
    schedule();
  };
  const signal = event => {
    if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged' && event.args?.[0] === SENSOR) {
      owner = !!event.args[2]; claimed = false; claimFailed = false;
      available = false; orientation = undefined; ++generation; ++serviceGeneration; cancel();
      if (owner) enqueue(async () => { await read(); await reconcile(); });
    } else if (event.path === PATH && event.interface === 'org.freedesktop.DBus.Properties' &&
      event.member === 'PropertiesChanged' && event.args?.[0] === SENSOR) {
      const changes = event.args[1] || {}, invalidated = event.args[2] || [];
      if (!['HasAccelerometer', 'AccelerometerOrientation'].some(key => key in changes || invalidated.includes(key))) return;
      // Cancel immediately, even if a compositor query is still in flight.
      // Queuing the sample behind that query can apply an obsolete rotation.
      update({ ...changes, ...Object.fromEntries(invalidated.map(key => [key, undefined])) });
      enqueue(async () => { await read(); await reconcile(); });
    }
  };
  return {
    start: async () => {
      if (started || closed) return;
      await Bus.connect(); Bus.onSignal(signal);
      await Bus.addMatch("type='signal',sender='net.hadess.SensorProxy',path='/net/hadess/SensorProxy',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'");
      await Bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='net.hadess.SensorProxy'");
      started = true;
      const token = serviceGeneration;
      const present = await Bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner', 's', SENSOR);
      if (token === serviceGeneration) owner = present;
      return enqueue(async () => { if (owner) await read(); await reconcile(); });
    },
    onState: next => {
      const before = wanted(); state = next;
      if (before !== wanted()) { ++generation; claimFailed = false; cancel(); }
      return enqueue(reconcile);
    },
    dispose: () => {
      closed = true; ++generation; cancel(); Bus.offSignal(signal);
      return enqueue(reconcile);
    }
  };
}

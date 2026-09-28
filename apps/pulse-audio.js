import * as Process from 'Module/process';
import * as Log from 'Helix/Log';

// Existing Koya APIs cover this platform integration. PulseAudio owns the real
// audio state; this cache and all button policy belong to the Koya frontend.
export function pulseAudio({ changed = () => {}, command = '/usr/bin/pactl' } = {}) {
  let snapshot = { available: false, percent: 0, muted: false, error: '' };
  let config = {}, subscription, retry, retries = 0, buffer = '';
  let dirty = false, running = false, closed = false, initialized = false, show = false;
  const steps = [];
  let balance;
  const run = args => new Promise((resolve, reject) => {
    let child, stdout = '', stderr = '', settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    };
    const timer = setTimeout(() => { try { child?.kill(); } catch (_) {} finish(new Error('Audio server timed out')); }, 1800);
    try {
      child = Process.spawn({ cmd: '/usr/bin/env', args: ['LC_ALL=C', command, ...args] });
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        if (stdout.length > 4 * 1024 * 1024) {
          try { child.kill(); } catch (_) {}
          finish(new Error('Audio response too large'));
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
      child.on('exit', code => finish(code ? new Error(stderr.trim() || 'Audio command failed') : undefined));
    } catch (error) { finish(error); }
  });
  const publish = (next, requested = false) => {
    const different = JSON.stringify(next) !== JSON.stringify(snapshot);
    snapshot = next;
    if (!closed && (different || requested)) changed(snapshot, requested);
  };
  const read = async () => {
    const [name, data] = await Promise.all([
      config.VolumeSink ? Promise.resolve(config.VolumeSink) : run(['get-default-sink']),
      run(['--format=json', 'list', 'sinks'])
    ]);
    const sink = JSON.parse(data).find(item => item.name === name.trim());
    if (!sink || sink.properties?.['device.class'] === 'abstract' || sink.name === 'auto_null')
      throw new Error('No audio output');
    const channels = Object.values(sink.volume).map(channel => Number(channel.value));
    if (!channels.length || channels.some(value => !Number.isFinite(value))) throw new Error('Invalid audio volume');
    const highest = Math.max(...channels);
    if (highest > 0) balance = { name: sink.name, weights: channels.map(value => value / highest) };
    return { available: true, name: sink.name, index: sink.index, description: sink.description,
      channels, percent: Math.round(Math.max(...channels) * 100 / 65536), muted: !!sink.mute, error: '' };
  };
  const pump = async () => {
    if (running || closed) return;
    running = true;
    try {
      while (!closed && (dirty || steps.length)) {
        dirty = false;
        // Read after every write; never base a subsequent press on a stale cache.
        let next = await read();
        const count = steps.length;
        if (count) {
          const actions = steps.splice(0, count);
          let percent = next.percent;
          for (const direction of actions) percent = Math.max(0, Math.min(config.VolumeMaxPercent ?? 100,
            percent + direction * (config.VolumeStepPercent ?? 5)));
          const highest = Math.max(...next.channels);
          const volumes = next.channels.map((value, index) => ((highest ? value / highest
            : balance?.name === next.name ? balance.weights[index] ?? 1 : 1) * percent).toFixed(3) + '%');
          // Named output pins the routing for the read/write transaction.
          await run(['set-sink-volume', next.name, ...volumes]);
          if (next.muted && actions.some(direction => direction > 0)) await run(['set-sink-mute', next.name, '0']);
          next = await read();
        }
        const requested = show; show = false;
        const audibleChange = initialized && (next.name !== snapshot.name || next.percent !== snapshot.percent || next.muted !== snapshot.muted);
        initialized = true; retries = 0;
        publish(next, requested || audibleChange);
      }
    } catch (error) {
      steps.length = 0; dirty = false;
      const requested = show; show = false;
      publish({ available: false, percent: 0, muted: false, error: String(error.message || error) }, requested);
      Log.error('Audio: ' + error);
    } finally { running = false; }
  };
  const refresh = () => { dirty = true; pump(); };
  const listen = () => {
    if (closed || subscription) return;
    clearTimeout(retry); buffer = '';
    try {
      // A persistent event stream sleeps between changes. Parent death also
      // cleans it up if Koya exits unexpectedly.
      subscription = Process.spawn({ cmd: '/bin/setpriv', args: ['--pdeathsig', 'TERM', '/usr/bin/env', 'LC_ALL=C', command, 'subscribe'] });
      subscription.stdout.on('data', chunk => {
        buffer += String(chunk);
        const lines = buffer.split('\n'); buffer = lines.pop().slice(-4096);
        for (const line of lines) {
          const event = /^Event '(new|change|remove)' on (sink|server|card) #(\d+)/.exec(line);
          if (event && (event[2] !== 'sink' || event[1] !== 'change' || Number(event[3]) === snapshot.index)) refresh();
        }
      });
      subscription.on('exit', () => {
        subscription = undefined;
        if (closed) return;
        publish({ available: false, percent: 0, muted: false, error: 'Audio server disconnected' });
        // Bounded recovery, not an idle retry/polling loop. A button can retry.
        if (++retries <= 3) retry = setTimeout(() => { listen(); refresh(); }, 3000);
      });
    } catch (error) {
      subscription = undefined;
      Log.error('Audio subscription: ' + error);
    }
  };
  return {
    configure: value => { config = value; },
    start: () => { listen(); refresh(); },
    adjust: direction => { if (closed) return; if (!subscription) { retries = 0; listen(); } steps.push(direction); show = true; dirty = true; pump(); },
    refresh,
    get snapshot() { return snapshot; },
    get busy() { return running; },
    dispose: () => { closed = true; clearTimeout(retry); try { subscription?.kill(); } catch (_) {} }
  };
}

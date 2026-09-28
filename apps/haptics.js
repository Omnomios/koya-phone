import { session as Bus } from 'Module/dbus';
import * as Log from 'Helix/Log';

let state = {}, last = 0, pending = false, retryAfter = 0;
export function configureHaptics(value) { state = value; }

// UI policy lives in Koya. feedbackd owns motor access and the device's theme.
export function haptic() {
  const now = Date.now();
  if (!state.Active || state.HapticsEnabled === false || pending || now < retryAfter
      || now - last < (state.HapticsMinIntervalMs ?? 45)) return;
  last = now; pending = true;
  Bus.callComplex('org.sigxcpu.Feedback', '/org/sigxcpu/Feedback', 'org.sigxcpu.Feedback',
    'TriggerFeedback', 'ssa{sv}i', 'org.koya.Shell', 'button-pressed', { profile: 'quiet' }, -1)
    .catch(error => {
      retryAfter = Date.now() + 5000;
      Log.error('Haptic feedback: ' + error);
    }).finally(() => { pending = false; });
}

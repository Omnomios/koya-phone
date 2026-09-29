import { Bus, typed as t, serve, properties, changed, own, daemon, start } from './service.js';

const SENSOR = 'net.hadess.SensorProxy', PATH = '/net/hadess/SensorProxy';
const props = { HasAccelerometer: t('b', true), AccelerometerOrientation: t('s', 'normal') };
let claims = 0, releases = 0, claimed = false, reject = false;
export default start(async () => {
  properties(PATH, { [SENSOR]: props });
  serve(PATH, SENSOR, call => {
    if (call.member === 'ClaimAccelerometer') {
      if (reject) return call.error('org.freedesktop.DBus.Error.AccessDenied', 'Sensor claim not allowed');
      ++claims; claimed = true;
    } else if (call.member === 'ReleaseAccelerometer') { ++releases; claimed = false; }
    else return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    call.reply('');
  });
  serve(PATH, 'org.koya.Test.Sensor', async call => {
    if (call.member === 'Orientation') {
      props.AccelerometerOrientation = t('s', call.args[0]);
      if (claimed) changed(PATH, SENSOR, { AccelerometerOrientation: props.AccelerometerOrientation });
    } else if (call.member === 'Available') {
      props.HasAccelerometer = t('b', call.args[0]); changed(PATH, SENSOR, { HasAccelerometer: props.HasAccelerometer });
    } else if (call.member === 'Reject') reject = call.args[0];
    else if (call.member === 'Drop') { claimed = false; await daemon('ReleaseName', 's', SENSOR); }
    else if (call.member === 'Own') await own(SENSOR);
    else if (call.member === 'Counts') return call.reply('a{sv}', {
      Claims: t('u', claims), Releases: t('u', releases), Claimed: t('b', claimed) });
    else return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    call.reply('');
  });
  await own(SENSOR); await own('org.koya.Test.Sensor');
});

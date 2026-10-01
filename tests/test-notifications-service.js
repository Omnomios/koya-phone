import * as Observer from 'Module/dbus';
import { system as Client } from 'Module/dbus';
import { Bus, Process, wait, sleep, assert, equal, denied, run } from './check.js';
import { Notifications } from '../apps/notifications-model.js';
import { startNotifications, emitNotification } from '../apps/notifications-service.js';
const NAME = 'org.freedesktop.Notifications', PATH = '/org/freedesktop/Notifications';
export default run(async () => {
  await Client.connect(); await Observer.connect('session');
  await Client.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', 'su', 'org.koya.Test.NotificationClient', 4);
  const target = await Bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', 'org.koya.Test.NotificationClient');
  const signals = [], unrelated = [];
  Client.addMatch("type='signal',interface='org.freedesktop.Notifications'");
  Observer.addMatch("type='signal',interface='org.freedesktop.Notifications'");
  Client.onSignal(event => { if (event.interface === NAME) signals.push(event); });
  Observer.onSignal(event => { if (event.interface === NAME) unrelated.push(event); });
  const model = new Notifications({ signal: (...args) => emitNotification(Bus, ...args) });
  await startNotifications(Bus, model);
  const notify = (client, replaces = 0) => client.callComplex(NAME, PATH, NAME, 'Notify', 'susssasa{sv}i',
    'Test app', replaces, '', 'Message', 'Body', ['default', 'Open'], { urgency: { _t: 'y', _v: 1 } }, 0);
  const id = Number(await notify(Client));
  assert(model.records.get(id).sender === target, 'Notification lost the original client identity');
  equal(Number(await notify(Client, id)), id, 'Replacement allocated a new ID');
  const other = Number(await notify(Observer, id));
  assert(other !== id, 'Another client replaced a notification it did not own');
  equal(await Client.call(NAME, PATH, NAME, 'GetCapabilities'), ['body', 'actions', 'persistence']);
  equal((await Process.exec('gdbus call --session --dest org.freedesktop.Notifications --object-path /org/freedesktop/Notifications --method org.freedesktop.Notifications.GetServerInformation')).stdout.trim(), "('Koya', 'Koya', '0.1.0', '1.3')");
  const xml = await Client.call(NAME, PATH, 'org.freedesktop.DBus.Introspectable', 'Introspect');
  assert(xml.includes('NotificationClosed') && xml.includes('GetCapabilities'), 'Introspection is incomplete');
  await denied(() => Client.call(NAME, PATH, NAME, 'CloseNotification', 's', 'bad'));
  await denied(() => Client.call(NAME, PATH, NAME, 'UnknownMethod'));
  await denied(() => Client.callComplex(NAME, PATH, NAME, 'Notify', 'susssasa{sv}i',
    'Test', 0, '', 'Large', 'x'.repeat(1024 * 1024 + 1), [], {}, 0));
  model.invoke(id, 'default');
  await wait(() => signals.length === 2, 'Directed notification signals were not delivered');
  equal(signals.map(event => event.member), ['ActionInvoked', 'NotificationClosed']);
  equal(signals[0].args, [id, 'default']); equal(signals[1].args, [id, 2]);
  await sleep(100); equal(unrelated.length, 0, 'Notification signals leaked to an unrelated subscriber');
  model.dispose();
});

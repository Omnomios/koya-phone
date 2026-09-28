import { session as Bus } from 'Module/dbus';

// Independent session connection: Wi-Fi uses the system handle concurrently.
let connection;
export async function keyboardVisible(visible) {
  if (!connection) connection = Bus.connect().catch(error => { connection = undefined; throw error; });
  await connection;
  return Bus.call('sm.puri.OSK0', '/sm/puri/OSK0', 'sm.puri.OSK0', 'SetVisible', 'b', visible);
}

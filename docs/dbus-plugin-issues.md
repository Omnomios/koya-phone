# D-Bus plugin issues observed by the shell

Observed with Koya 0.5.2 build 886 / installed `Module/dbus`, aarch64, 2026-09-28.
These are runtime observations, not diagnoses from the plugin's source code.

Build 888 update: installed engine and D-Bus plugin are `0.5.3-r888`. The current
[D-Bus documentation](https://developer.koya-ui.com/module-dbus/index.html)
defines independent `session`/`system` handles and recursively decoded `event.args`.
The shell now uses those handles, typed hardware/state signals and saved-profile
GetSettings replies. The descriptions below record the build 886 failures.
The windowless verification probe segfaulted before reporting a result, and the
private fixture's GObject bindings are missing, so build 888's fixes still need
verification in the graphical session. Do not treat documentation as a passing test.

## 1. Byte values contain garbage upper bits

Read `org.freedesktop.NetworkManager.AccessPoint` with
`org.freedesktop.DBus.Properties.GetAll(s)`.

Expected `Ssid: [72, 111, 109, 101]` and `Strength: 62`.
Observed `Ssid: [3055075656, 3055075695, 3055075693, 3055075685]` and
`Strength: 3055075646`. Other byte values in the same snapshot sometimes decoded
correctly. The low eight bits were correct in the captured failures.

Handle D-Bus `y` as an unsigned byte, including through variants and `ay` arrays.
Likely worth checking that no wider integer read uses uninitialised upper bytes.
Do not apply a byte mask to other integer signatures.

Current workaround: `Number(value) & 255` for SSID bytes and Wi-Fi strength in
`apps/wifi-model.js`. Test both bare `y`, `v(y)` and byte arrays inside dictionaries.

## 2. Nested dictionary replies decode to null

Call `org.freedesktop.NetworkManager.Settings.Connection.GetSettings()`.
Its reply is `a{sa{sv}}`. Expected:

```js
{
  connection: { id: 'Home', type: '802-11-wireless' },
  '802-11-wireless': { ssid: [72, 111, 109, 101] },
  '802-11-wireless-security': { 'key-mgmt': 'wpa-psk' }
}
```

Observed:

```js
{
  connection: null,
  '802-11-wireless': null,
  '802-11-wireless-security': null
}
```

Recursively decode arrays, dictionary entries, structs and variants; do not
require inner dictionaries to be wrapped in a variant. Also cover ObjectManager
`a{oa{sa{sv}}}` replies and nested arrays/structs in connection settings.

Build 888 integration reads GetSettings for available profiles and shows saved
networks. It preserves existing profiles and uses NetworkManager's automatic
selection when no readable profile is found. Profiles created in this app run
retain their path/UUID for retries. Outgoing `a{sa{sv}}` marshalling passed the
earlier private credential-write fixture; this issue concerned reply decoding.

## 3. Composite signal bodies are lost

The shell's `HardwareButton(a{sv})` did not deliver its dictionary through
`Bus.onSignal`. Composite notification payloads required the same workaround.
Use the recursive reply decoder for signal arguments too.

The shell now consumes typed `HardwareButton` and `StateChanged` from `args[0]`.
The native hardware JSON mirror remains for external compatibility.
`NotificationRequest(s)` retains its existing serialized RPC envelope; the
frontend reads its string from `args[0]`.

## 4. Only the first signal argument is exposed

For `org.freedesktop.DBus.NameOwnerChanged(s name, s oldOwner, s newOwner)`,
`event.body` exposes the name; the two owner arguments are unavailable.
The shell consequently queries state again instead of using those arguments.

Expose all arguments in order, preferably an `args` array with native JS values.
Keeping `body` as the first argument would preserve current callers during a
transition. Apply the same representation to zero-argument and composite signals.

## Connection API limitation

Build 888 documents `session` and `system` handles with independent connections,
calls, match rules and signal callbacks. The module-level API remains a legacy
single connection and rejects changing buses after connection. The shell now
uses explicit handles throughout; Wi-Fi can use both buses without a gdbus child.

`TextDecoder` being absent is a separate Helix runtime gap, not a D-Bus issue.
The frontend uses UTF-8 decoding through `decodeURIComponent` and preserves the
raw byte sequence even for invalid UTF-8 names.

## Existing focused reproduction

`tests/fixtures/wifi.py` provides a private NetworkManager service with typed
SSID/signal-strength properties and nested GetSettings replies. Run a Koya/plugin
probe against this service on a private system bus to inspect raw replies without
changing host networking. The previous compositor smoke runner has been retired;
the private service fixture remains available.

The frontend retains byte normalization and missing-profile fallbacks, so a
passing shell check alone does not prove those plugin defects have been fixed.
Check raw replies and signal arguments when verifying the plugin release.

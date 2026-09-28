// NetworkManager owns profiles and connectivity; Koya owns selection and UI state.
// The installed D-Bus module decodes some `y` values with garbage upper bits.
export const ssidBytes = value => Array.from(value || [], byte => Number(byte) & 255);
function ssidName(bytes) {
  // Helix does not currently expose TextDecoder. Preserve the raw SSID bytes
  // for activation, even if the advertised name is not valid UTF-8.
  try { return decodeURIComponent(bytes.map(byte => '%' + byte.toString(16).padStart(2, '0')).join('')).replace(/[\x00-\x1f\x7f]/g, '�'); }
  catch (_) { return bytes.map(byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '�').join(''); }
}
export function security(ap) {
  const flags = Number(ap.RsnFlags || 0) | Number(ap.WpaFlags || 0);
  if (flags & 0x100) return 'wpa-psk';
  if (flags & 0x400) return 'sae';
  if (flags & (0x800 | 0x1000)) return 'owe';
  if (flags & (0x200 | 0x2000)) return 'enterprise';
  return Number(ap.Flags) & 1 ? 'wep' : 'open';
}
export function networks(accessPoints, profiles, active) {
  const grouped = new Map();
  for (const ap of accessPoints) {
    const ssid = ssidBytes(ap.Ssid);
    if (!ssid.length) continue;
    const kind = security(ap), key = ssid.join(',') + ':' + kind;
    const saved = profiles.find(profile => {
      const wireless = profile.settings['802-11-wireless'];
      const management = profile.settings['802-11-wireless-security']?.['key-mgmt'];
      return wireless && ssidBytes(wireless.ssid).join(',') === ssid.join(',')
        && (kind === 'open' ? !management : kind === 'enterprise' ? management?.startsWith('wpa-eap') : management === kind);
    });
    const row = { ...ap, Ssid: ssid, Strength: Number(ap.Strength) & 255, ssid, key, security: kind, saved,
      name: ssidName(ssid), connected: ap.path === active,
      password: kind === 'wpa-psk' || kind === 'sae', supported: !['wep', 'enterprise'].includes(kind) || !!saved };
    const prior = grouped.get(key);
    if (!prior || row.connected || (!prior.connected && Number(row.Strength) > Number(prior.Strength))) grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => Number(b.connected) - Number(a.connected)
    || Number(b.Strength) - Number(a.Strength) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
export function validPassword(kind, value) {
  return kind === 'sae' ? value.length > 0
    : /^[\x20-\x7e]{8,63}$/.test(value) || /^[0-9a-fA-F]{64}$/.test(value);
}
export function connectionSettings(network, password, user) {
  const settings = {
    connection: { id: 'Koya Wi-Fi: ' + network.name, type: '802-11-wireless', autoconnect: true,
      permissions: { _t: 'as', _v: ['user:' + user + ':'] } },
    '802-11-wireless': { ssid: { _t: 'ay', _v: network.ssid }, mode: 'infrastructure' },
    ipv4: { method: 'auto' }, ipv6: { method: 'auto' }
  };
  if (network.security !== 'open') {
    settings['802-11-wireless-security'] = { 'key-mgmt': network.security };
    if (network.password) Object.assign(settings['802-11-wireless-security'], { psk: password, 'psk-flags': { _t: 'u', _v: 0 } });
  }
  return settings;
}

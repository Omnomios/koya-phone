// Keep display decisions separate from service-specific D-Bus enums.
export function topBarStatus(state) {
  const percent = Number(state.BatteryPercent);
  const batteryKnown = state.BatteryPresent && Number.isFinite(percent) && percent >= 0 && percent <= 100;
  const wifiConnected = state.WifiState === 'connected';
  const wifiStrength = Number(state.WifiStrength);
  const cellConnected = state.CellularState === 'registered' || state.CellularState === 'roaming';
  const cellStrength = Number(state.CellularStrength);
  const bars = (value, maximum) => Number.isFinite(value) && value >= 0 ? Math.min(maximum, Math.ceil(value * maximum / 100)) : 0;
  return {
    batteryIcon: batteryKnown ? 'battery-' + Math.ceil(percent / 10) : 'battery-unknown',
    batteryText: batteryKnown ? Math.round(percent) + '%' : '—',
    batteryLow: batteryKnown && percent <= 15 && !state.ExternalPower && state.BatteryState !== 'charging',
    charging: !!state.ExternalPower || state.BatteryState === 'charging',
    wifiIcon: wifiConnected ? 'wifi-' + bars(wifiStrength, 3) : state.WifiState === 'connecting' ? 'wifi-0' : 'wifi-off',
    cellIcon: cellConnected ? 'cell-' + bars(cellStrength, 4) : 'cell-off',
    cellText: cellConnected ? state.CellularTechnology || '' : '',
    roaming: state.CellularState === 'roaming',
    wired: state.NetworkType === 'ethernet' && state.NetworkState === 'connected',
    warning: state.NetworkState === 'connected' && ['portal', 'limited', 'none'].includes(state.NetworkConnectivity)
  };
}

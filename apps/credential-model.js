export const cleanCredential = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '');
export const validPin = value => /^\d{4,12}$/.test(value);
export const pinSalt = profile => profile.AuthenticationMode === 'pin' ? profile.AuthenticationSalt
  : profile.PendingAuthenticationMode === 'pin' ? profile.PendingAuthenticationSalt : '';
export const credentialMode = (profile, user, literal = false) => !literal && user === profile.UserName && profile.AuthenticationMode === 'pin' ? 'pin' : 'password';
export async function credentialAnswer(value, mode, profile, derive) {
  if (mode === 'password') return cleanCredential(value);
  if (!validPin(value) || !/^[a-f0-9]{64}$/.test(pinSalt(profile))) throw new Error('Enter a PIN of 4 to 12 digits');
  return derive(value, mode === 'pin-pending' ? profile.PendingAuthenticationSalt : pinSalt(profile));
}

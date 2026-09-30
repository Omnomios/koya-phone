const SHA = /^[0-9a-f]{40}$/i;

export const commitHash = value => SHA.test(String(value || '')) ? String(value).toLowerCase() : '';
export const shortHash = value => value ? value.slice(0, 7) : '—';

export function compareVersion(installed, head, response) {
  head = commitHash(head);
  if (!installed || !head) throw new Error('Invalid repository revision');
  if (head === installed) return { kind: 'current', head, message: 'Up to date' };
  const base = commitHash(response?.base_commit?.sha);
  const ahead = response?.ahead_by, behind = response?.behind_by;
  if (base !== installed || !Number.isSafeInteger(ahead) || ahead < 0 ||
      !Number.isSafeInteger(behind) || behind < 0) throw new Error('Invalid repository comparison');
  if (ahead && !behind) return { kind: 'behind', head, message: `Update available · ${ahead} commit${ahead === 1 ? '' : 's'} behind` };
  if (behind && !ahead) return { kind: 'ahead', head, message: `Installed ${behind} commit${behind === 1 ? '' : 's'} ahead of branch` };
  if (ahead && behind) return { kind: 'diverged', head, message: `${ahead} new · ${behind} local-only commits` };
  throw new Error('Invalid repository comparison');
}

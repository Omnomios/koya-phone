import assert from 'node:assert/strict';
import { commitHash, shortHash, compareVersion } from '../apps/update-version.js';

const installed = 'a'.repeat(40), newer = 'b'.repeat(40);
const comparison = (ahead_by, behind_by) => ({
  base_commit: { sha: installed }, ahead_by, behind_by
});

assert.equal(commitHash(installed.toUpperCase()), installed);
assert.equal(commitHash('master'), '');
assert.equal(shortHash(installed), 'aaaaaaa');
assert.deepEqual(compareVersion(installed, installed),
  { kind: 'current', head: installed, message: 'Up to date' });
assert.deepEqual(compareVersion(installed, newer, comparison(3, 0)),
  { kind: 'behind', head: newer, message: 'Update available · 3 commits behind' });
assert.deepEqual(compareVersion(installed, newer, comparison(0, 2)),
  { kind: 'ahead', head: newer, message: 'Installed 2 commits ahead of branch' });
assert.deepEqual(compareVersion(installed, newer, comparison(4, 2)),
  { kind: 'diverged', head: newer, message: '4 new · 2 local-only commits' });
assert.throws(() => compareVersion(installed, newer, { ...comparison(1, 0), base_commit: { sha: newer } }));
assert.throws(() => compareVersion(installed, newer, comparison(-1, 0)));
console.log('PASS: updater commit comparison');

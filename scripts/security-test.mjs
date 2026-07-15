import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { auditCreateRejection, auditMergeRejection, auditTargetRejection, buildAuditConstraints } from '../extensions/core/audit-guard.ts';
import { atomicWriteFileSync } from '../extensions/core/atomic-file.ts';
import { purgeScopedRecordVersions } from '../extensions/core/jsonl-maintenance.ts';
import { boundedStrings, truncateText } from '../extensions/core/limits.ts';
import { safeRepoFile } from '../extensions/core/repo-path.ts';
import { normalizeRepoMap } from '../extensions/core/repo-map-schema.ts';
import { withCrossProcessFileLocks } from '../extensions/core/file-lock.ts';
import { initializeDir } from '../extensions/runtime/foundation.ts';

const projectDecision = { key: 'project:decision-a', scope: 'project', kind: 'decision', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' };
const projectDecisionB = { key: 'project:decision-b', scope: 'project', kind: 'decision', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' };
const constraints = buildAuditConstraints([projectDecision, projectDecisionB]);

assert.equal(auditTargetRejection(constraints, projectDecision.key, projectDecision), undefined, 'unchanged audited record should remain actionable');
assert.match(auditTargetRejection(constraints, 'project:not-audited', undefined) ?? '', /not included/, 'off-packet record should be rejected');
assert.match(auditTargetRejection(constraints, projectDecision.key, { ...projectDecision, updatedAt: '2026-02-01T00:00:00.000Z' }) ?? '', /changed/, 'stale audit snapshot should be rejected');
assert.match(auditTargetRejection(constraints, projectDecision.key, { ...projectDecision, status: 'stale' }) ?? '', /now stale/, 'inactive record should be rejected');
assert.equal(auditCreateRejection(constraints, 'project', 'decision'), undefined, 'create should stay within represented scope and kind');
assert.match(auditCreateRejection(constraints, 'user', 'decision') ?? '', /scope/, 'create should not cross packet scope');
assert.match(auditCreateRejection(constraints, 'project', 'preference') ?? '', /kind/, 'create should not invent a packet kind');
assert.equal(auditMergeRejection([projectDecision, projectDecisionB], 'project', 'decision'), undefined, 'same-scope same-kind merge should be allowed');
assert.match(auditMergeRejection([projectDecision, { ...projectDecisionB, scope: 'user' }], undefined, undefined) ?? '', /cross-scope/, 'cross-scope merge should be rejected');
assert.match(auditMergeRejection([projectDecision, { ...projectDecisionB, kind: 'recipe' }], undefined, undefined) ?? '', /cross-kind/, 'cross-kind merge should be rejected');

const targetId = 'privacy-target';
const purgeInput = [
  JSON.stringify({ schemaVersion: 0, id: targetId, scope: 'project', legacy: true }),
  JSON.stringify({ schemaVersion: 1, id: targetId, scope: 'project', content: 'latest' }),
  JSON.stringify({ schemaVersion: 1, id: targetId, scope: 'user', content: 'other scope' }),
  '{ unrelated malformed json',
].join('\n') + '\n';
const purge = purgeScopedRecordVersions(purgeInput, targetId, 'project');
assert.equal(purge.removed, 2, 'purge should remove every parseable target version regardless of schema');
assert.equal(purge.uncertainLines.length, 0, 'unrelated damaged lines should not block a targeted purge');
assert(purge.contents.includes('other scope'), 'purge should preserve same-id records in another scope');
assert(purge.contents.includes('unrelated malformed'), 'purge should preserve unrelated damaged lines');
const uncertain = purgeScopedRecordVersions(`{"id":"${targetId}", broken\n`, targetId, 'project');
assert.deepEqual(uncertain.uncertainLines, [1], 'damaged lines mentioning the target should force an explicit repair');

assert.equal(truncateText('abcdef', 4), 'abc…', 'bounded text should make truncation visible');
assert.deepEqual(boundedStrings(['abcdef', 'two', 'three'], 2, 4), ['abc…', 'two'], 'bounded arrays should cap both count and element length');

const root = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-security-'));
const outside = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-outside-'));
process.once('exit', () => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
writeFileSync(join(root, 'safe.ts'), 'export const safe = true;\n');
writeFileSync(join(outside, 'private.ts'), 'export const privateValue = true;\n');
symlinkSync(join(outside, 'private.ts'), join(root, 'escape.ts'));
assert(safeRepoFile(root, 'safe.ts'), 'regular contained repo file should be accepted');
assert.equal(safeRepoFile(root, 'escape.ts'), undefined, 'outside-root symlink should be rejected');
assert.equal(safeRepoFile(root, '../outside.ts'), undefined, 'lexical traversal should be rejected');

const normalizedMap = normalizeRepoMap({
  schemaVersion: 1,
  root,
  generatedAt: new Date().toISOString(),
  files: [
    { path: 'safe.ts', kind: 'typescript', symbols: ['safe'], imports: [], size: 1 },
    { path: '../escape.ts', kind: 'typescript', symbols: ['privateValue'], imports: [], size: 1 },
    { path: '.env', kind: 'text', symbols: ['SECRET_TOKEN'], imports: [], size: 1 },
  ],
});
assert.deepEqual(normalizedMap?.files.map((file) => file.path), ['safe.ts'], 'repo-map cache validation should discard traversal and sensitive paths');
assert.equal(normalizeRepoMap({ schemaVersion: 99, root, generatedAt: new Date().toISOString(), files: [] }), undefined, 'unknown repo-map schemas should be rejected');

const atomicFile = join(root, 'atomic.txt');
writeFileSync(atomicFile, 'before', 'utf8');
chmodSync(atomicFile, 0o640);
atomicWriteFileSync(atomicFile, 'after');
assert.equal(readFileSync(atomicFile, 'utf8'), 'after', 'atomic replacement should publish the complete new contents');
assert.equal(statSync(atomicFile).mode & 0o777, 0o640, 'atomic replacement should preserve file permissions');
assert(!readdirSync(root).some((name) => name.includes('.tmp-')), 'atomic replacement should not leave temporary files');

const newAtomicFile = join(root, 'atomic-new.txt');
atomicWriteFileSync(newAtomicFile, 'private');
assert.equal(statSync(newAtomicFile).mode & 0o777, 0o600, 'new atomic files should default to private permissions');

const privateMemory = join(root, 'private-memory');
initializeDir(privateMemory, 'project');
assert.equal(statSync(privateMemory).mode & 0o777, 0o700, 'memory directories should be private');
for (const name of ['records.jsonl', 'summary.md', 'state.json', 'active.json']) {
  assert.equal(statSync(join(privateMemory, name)).mode & 0o777, 0o600, `${name} should be private`);
}
const linkedMemory = join(root, 'linked-memory');
symlinkSync(outside, linkedMemory, 'dir');
assert.throws(() => initializeDir(linkedMemory, 'project'), /Unsafe hybrid-memory directory/, 'memory stores should reject symlinked directories');

const lockedCounter = join(root, 'locked-counter.txt');
writeFileSync(lockedCounter, '0', 'utf8');
await Promise.all(Array.from({ length: 12 }, async (_, index) => {
  await withCrossProcessFileLocks([lockedCounter], async () => {
    const current = Number(readFileSync(lockedCounter, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    writeFileSync(lockedCounter, String(current + 1), 'utf8');
  }, { timeoutMs: 2_000 });
}));
assert.equal(readFileSync(lockedCounter, 'utf8'), '12', 'filesystem locks should serialize overlapping mutation windows');
assert(!readdirSync(root).some((name) => name.endsWith('.lock')), 'filesystem locks should clean up after successful mutations');

writeFileSync(lockedCounter, '0', 'utf8');
const lockModule = new URL('../extensions/core/file-lock.ts', import.meta.url).href;
const worker = `
  import { readFileSync, writeFileSync } from 'node:fs';
  import { withCrossProcessFileLocks } from ${JSON.stringify(lockModule)};
  const file = process.argv[1];
  for (let index = 0; index < 5; index++) {
    await withCrossProcessFileLocks([file], async () => {
      const current = Number(readFileSync(file, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, index % 2));
      writeFileSync(file, String(current + 1), 'utf8');
    });
  }
`;
await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, lockedCounter], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock worker exited ${code}: ${stderr}`)));
})));
assert.equal(readFileSync(lockedCounter, 'utf8'), '20', 'filesystem locks should serialize independent Pi processes');

console.log('pi-hybrid-memory security contracts ok');

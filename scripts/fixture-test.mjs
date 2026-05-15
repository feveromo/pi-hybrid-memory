import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const pkg = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-fixture-'));
const home = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-home-'));

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf8', ...opts, env: { ...process.env, HOME: home, ...(opts.env ?? {}) } });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

run('git', ['init', '-q']);
writeFileSync(join(tmp, 'tracked.ts'), 'export const tracked = 1;\n');
run('git', ['add', 'tracked.ts']);
writeFileSync(join(tmp, 'untracked.ts'), 'export const untracked = 2;\n');
mkdirSync(join(tmp, '.pi', 'hybrid-memory'), { recursive: true });
writeFileSync(join(tmp, '.pi', 'hybrid-memory', 'should-not-map.ts'), 'export const runtimeState = true;\n');

run('pi', ['--no-session', '-e', pkg, '-p', '/hmemory-repomap']);

const map = JSON.parse(readFileSync(join(tmp, '.pi', 'hybrid-memory', 'repomap.json'), 'utf8'));
const paths = map.files.map((f) => f.path).sort();
if (!paths.includes('tracked.ts')) throw new Error('repo map missed tracked file');
if (!paths.includes('untracked.ts')) throw new Error('repo map missed untracked non-ignored file');
if (paths.some((p) => p.startsWith('.pi/'))) throw new Error('repo map included .pi runtime state');

run('pi', ['--no-session', '-e', pkg, '-p', '/hmemory-prune foo']);

console.log(`pi-hybrid-memory fixture ok: ${tmp}`);

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const pkg = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-fixture-'));
const home = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-home-'));
process.once('exit', () => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf8', ...opts, env: { ...process.env, HOME: home, ...(opts.env ?? {}) } });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

function boundarySampleFixture(readMaxBytes) {
  const size = 50_000;
  const windowBytes = Math.max(1024, Math.floor(readMaxBytes / 3));
  const middleStart = Math.floor((size - windowBytes) / 2);
  const tailStart = size - windowBytes;
  const chars = Array.from({ length: size }, (_, i) => (i % 97 === 0 ? '\n' : ' '));
  const put = (offset, text) => {
    for (let i = 0; i < text.length; i++) chars[offset + i] = text[i];
  };
  put(middleStart - 120, 'export function boundaryMiddleSymbol() { return true; }\n');
  put(tailStart - 120, 'import boundaryThing from "boundary-lib";\nexport function boundaryTailPreludeSymbol() { return boundaryThing; }\n');
  return chars.join('');
}

run('git', ['init', '-q']);
writeFileSync(join(tmp, 'tracked.ts'), 'export const tracked = 1;\n');
run('git', ['add', 'tracked.ts']);
writeFileSync(join(tmp, 'untracked.ts'), 'export const untracked = 2;\n');
const outsideFile = join(home, 'outside.ts');
writeFileSync(outsideFile, 'import "outside-private-module";\nexport const outsidePrivateSymbol = true;\n');
symlinkSync(outsideFile, join(tmp, 'tracked-symlink.ts'));
run('git', ['add', 'tracked-symlink.ts']);
writeFileSync(join(tmp, 'sensitive-metadata.ts'), 'export default function(pi) { pi.registerCommand("token=synthetic_secret_value_123456", { handler() {} }); }\n');
mkdirSync(join(tmp, '.pi', 'hybrid-memory'), { recursive: true });
const repoMapReadMaxBytes = 16000;
writeFileSync(join(tmp, '.pi', 'settings.json'), JSON.stringify({ hybridMemory: { repoMap: { readMaxBytes: repoMapReadMaxBytes } } }, null, 2) + '\n');
writeFileSync(join(tmp, '.pi', 'hybrid-memory', 'should-not-map.ts'), 'export const runtimeState = true;\n');
writeFileSync(join(tmp, 'large-boundary.ts'), boundarySampleFixture(repoMapReadMaxBytes));
writeFileSync(join(tmp, 'large-extension.ts'), [
  'import { thing } from "large-lib";\n',
  'export function largeHeadSymbol() { return thing; }\n',
  '// filler before middle\n'.repeat(2500),
  'export function largeMiddleSymbol() { return true; }\n',
  '// filler after middle\n'.repeat(2500),
  'export function largeTailSymbol() { return true; }\n',
  'export default function(pi) {\n',
  '  pi.registerCommand("large-map", { handler() {} });\n',
  '  pi.registerTool({ name: "large_memory_tool", parameters: {}, async execute() { return { content: [] }; } });\n',
  '  pi.on("before_agent_start", () => undefined);\n',
  '}\n',
].join(''));

run('pi', ['--no-session', '-e', pkg, '-p', '/hmemory-repomap']);

const map = JSON.parse(readFileSync(join(tmp, '.pi', 'hybrid-memory', 'repomap.json'), 'utf8'));
const paths = map.files.map((f) => f.path).sort();
if (!paths.includes('tracked.ts')) throw new Error('repo map missed tracked file');
if (!paths.includes('untracked.ts')) throw new Error('repo map missed untracked non-ignored file');
if (paths.some((p) => p.startsWith('.pi/'))) throw new Error('repo map included .pi runtime state');
if (paths.includes('tracked-symlink.ts')) throw new Error('repo map followed a tracked symlink outside the repository');
const serializedMap = JSON.stringify(map);
if (serializedMap.includes('outside-private-module') || serializedMap.includes('outsidePrivateSymbol')) throw new Error('repo map persisted metadata read through an outside-root symlink');
if (serializedMap.includes('synthetic_secret_value_123456')) throw new Error('repo map persisted unredacted secret-like metadata');
const large = map.files.find((f) => f.path === 'large-extension.ts');
if (!large) throw new Error('repo map missed oversized source file');
if (!large.symbols.includes('largeHeadSymbol')) throw new Error('repo map missed oversized source head symbols');
if (!large.symbols.includes('largeMiddleSymbol')) throw new Error('repo map missed oversized source middle symbols');
if (!large.symbols.includes('largeTailSymbol')) throw new Error('repo map missed oversized source tail symbols');
if (!large.commands.includes('large-map')) throw new Error('repo map missed oversized source commands');
if (!large.tools.includes('large_memory_tool')) throw new Error('repo map missed oversized source tools');
if (!large.hooks.includes('before_agent_start')) throw new Error('repo map missed oversized source hooks');
if (!large.imports.includes('large-lib')) throw new Error('repo map missed oversized source imports');
const boundary = map.files.find((f) => f.path === 'large-boundary.ts');
if (!boundary) throw new Error('repo map missed boundary-sampling source file');
if (!boundary.symbols.includes('boundaryMiddleSymbol')) throw new Error('repo map missed symbol near middle sample boundary');
if (!boundary.symbols.includes('boundaryTailPreludeSymbol')) throw new Error('repo map missed symbol near tail sample boundary');
if (!boundary.imports.includes('boundary-lib')) throw new Error('repo map missed import near tail sample boundary');

run('pi', ['--no-session', '-e', pkg, '-p', '/hmemory-prune foo']);

console.log('pi-hybrid-memory fixture ok (temporary workspace cleaned)');

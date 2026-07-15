import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const tempRoot = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-benchmark-'));
process.once('exit', () => rmSync(tempRoot, { recursive: true, force: true }));
process.env.HOME = join(tempRoot, 'home');
mkdirSync(process.env.HOME, { recursive: true });

const extension = (await import(pathToFileURL(join(repoRoot, 'extensions', 'hybrid-memory.ts')).href)).default;
const cwd = join(tempRoot, 'project');
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, 'package.json'), '{"name":"benchmark-project"}\n');

const tools = new Map();
const handlers = new Map();
const ctx = {
  cwd,
  sessionManager: { getSessionFile: () => undefined },
  ui: { theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text }, setStatus: () => {}, setWidget: () => {}, notify: () => {}, custom: async () => undefined },
};
const pi = {
  on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  registerCommand: () => {},
  registerTool: (tool) => tools.set(tool.name, tool),
  getActiveTools: () => [...tools.keys()],
  getAllTools: () => [...tools.keys()].map((name) => ({ name })),
  setActiveTools: () => {},
};
extension(pi);

const remember = tools.get('hybrid_memory_remember');
await remember.execute('benchmark', {
  scope: 'project',
  kind: 'decision',
  subject: 'benchmark retrieval needle',
  content: 'Use the lunar-otter validation path for the benchmark target.',
  tags: ['lunar-otter'],
  salience: 5,
  pinned: false,
}, undefined, undefined, ctx);

const recordsFile = join(cwd, '.pi', 'hybrid-memory', 'records.jsonl');
const createdAt = new Date().toISOString();
const synthetic = Array.from({ length: 15_000 }, (_, index) => JSON.stringify({
  id: `noise-${index}`,
  schemaVersion: 1,
  scope: 'project',
  kind: 'codebase_note',
  subject: `unrelated module ${index}`,
  content: `Synthetic benchmark record ${index} about routine cache plumbing and ordinary module behavior.`,
  tags: [`bucket-${index % 100}`],
  status: 'active',
  salience: 1,
  pinned: false,
  createdAt,
  updatedAt: createdAt,
})).join('\n');
appendFileSync(recordsFile, `${synthetic}\n`, 'utf8');

const query = 'Where is the lunar-otter validation path documented?';
const messages = [{ role: 'user', content: query, timestamp: Date.now() }];
const contextHandlers = handlers.get('context') ?? [];
assert.equal(contextHandlers.length, 1, 'benchmark requires one context hook');

async function retrieve() {
  const result = await contextHandlers[0]({ messages }, ctx);
  return String(result?.messages?.find((message) => message.customType === 'hybrid-memory-context')?.content ?? '');
}

const warm = await retrieve();
assert(warm.includes('lunar-otter'), 'large-store retrieval should preserve the relevant record');
assert(!warm.includes('Synthetic benchmark record'), 'large-store retrieval should exclude unrelated noise');
assert(warm.length <= 4_300, `large-store context should remain bounded, got ${warm.length} chars`);

const samples = [];
for (let index = 0; index < 30; index++) {
  const start = performance.now();
  await retrieve();
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
const p50 = percentile(0.5);
const p95 = percentile(0.95);
assert(p95 < 100, `15k-record warm retrieval p95 should stay under 100ms, got ${p95.toFixed(1)}ms`);

const explain = await tools.get('hybrid_memory_explain').execute('benchmark', { query }, undefined, undefined, ctx);
assert(explain.details.candidates.some((candidate) => candidate.subject === 'benchmark retrieval needle'), 'explain tool should identify the relevant large-store candidate');

console.log(`pi-hybrid-memory benchmark ok (15,001 records, p50 ${p50.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, block ${warm.length} chars)`);

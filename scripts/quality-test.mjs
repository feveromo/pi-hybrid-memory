import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const tempRoot = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-quality-'));
process.once('exit', () => rmSync(tempRoot, { recursive: true, force: true }));
const tempHome = join(tempRoot, 'home');
mkdirSync(tempHome, { recursive: true });
process.env.HOME = tempHome;

const moduleFile = join(repoRoot, 'extensions', 'hybrid-memory.ts');
const extension = (await import(pathToFileURL(moduleFile).href)).default;

function projectMemoryDir(cwd) {
  return join(cwd, '.pi', 'hybrid-memory');
}

function makeHarness(cwd) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const ctx = {
    cwd,
    sessionManager: { getSessionFile: () => undefined },
    ui: { theme, setStatus: () => {}, setWidget: () => {}, notify: () => {}, custom: async () => undefined },
  };
  let activeTools = [];
  const pi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name, config) => commands.set(name, config),
    registerTool: (config) => { tools.set(config.name, config); activeTools.push(config.name); },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...tools.values()].map((tool) => ({ name: tool.name })),
    setActiveTools: (names) => { activeTools = [...names]; },
  };
  extension(pi);
  return {
    ctx,
    tool: async (name, params = {}) => tools.get(name).execute('quality', params, undefined, () => {}, ctx),
    command: async (name, args = '') => commands.get(name).handler(args, ctx),
    emit: async (event, payload = {}) => {
      const out = [];
      for (const handler of handlers.get(event) ?? []) out.push(await handler(payload, ctx));
      return out;
    },
  };
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

function stringUserMessage(text) {
  return { role: 'user', content: text, timestamp: Date.now() };
}

async function contextForPrompt(h, prompt, prior = []) {
  await h.emit('before_agent_start', { prompt, systemPrompt: 'base system prompt' });
  const results = await h.emit('context', { messages: [...prior, userMessage(prompt)] });
  const messages = results.find((result) => result?.messages)?.messages ?? [...prior, userMessage(prompt)];
  const memoryMessages = messages.filter((message) => message.role === 'custom' && message.customType === 'hybrid-memory-context');
  return { messages, memoryMessages, block: String(memoryMessages[0]?.content ?? '') };
}

const cwd = join(tempRoot, 'quality-project');
mkdirSync(join(cwd, 'src'), { recursive: true });
writeFileSync(join(cwd, 'src', 'main.ts'), 'export function qualityMain() { return "stable"; }\n', 'utf8');
execFileSync('git', ['init', '-q'], { cwd });
execFileSync('git', ['add', 'src/main.ts'], { cwd });

const h = makeHarness(cwd);
await h.tool('hybrid_memory_remember', {
  scope: 'user',
  kind: 'preference',
  subject: 'public repo privacy',
  content: 'Keep public repo docs and tests privacy-safe; use synthetic examples instead of private local paths.',
  pinned: true,
  salience: 5,
});
await h.tool('hybrid_memory_remember', {
  scope: 'project',
  kind: 'decision',
  subject: 'local JSONL architecture',
  content: 'This project should stay Pi-native, local-first, inspectable, and backed by append-only JSONL files.',
  pinned: true,
  salience: 5,
});
await h.tool('hybrid_memory_remember', {
  scope: 'project',
  kind: 'recipe',
  subject: 'validation commands',
  content: 'Useful project validation commands: npm test; npm run validate.',
  tags: ['commands'],
  pinned: true,
  salience: 5,
});
await h.tool('hybrid_memory_remember', {
  scope: 'project',
  kind: 'session_recap',
  subject: 'repo map sampling fix',
  content: 'Prior session (.): outcome: fixed repo-map sampling for oversized extension files; topics: quality harness / context injection.',
  filePaths: ['extensions/hybrid-memory.ts'],
  salience: 4,
});
const stale = await h.tool('hybrid_memory_remember', {
  scope: 'project',
  kind: 'decision',
  subject: 'old discarded direction',
  content: 'Old stale decision should not appear in the injected memory block.',
  salience: 5,
});
await h.tool('hybrid_memory_forget', { id: stale.details.id, scope: 'project', status: 'stale' });
await h.tool('hybrid_memory_remember', {
  scope: 'user',
  kind: 'codebase_note',
  subject: 'global editor telemetry hook',
  content: 'Global editor telemetry hook should only show up for directly relevant prompts.',
  filePaths: ['/tmp/outside/editor.js'],
  pinned: true,
  salience: 5,
});
await h.tool('hybrid_memory_remember', {
  scope: 'user',
  kind: 'preference',
  subject: 'thin imported command',
  content: 'Commit message should be useful later',
  tags: ['compaction', 'summary-mined'],
  salience: 2,
});
await h.command('hmemory-repomap');

const prompt = 'validate the local-first memory design, run npm test, and inspect src/main.ts qualityMain';
const first = await contextForPrompt(h, prompt);
assert.equal(first.memoryMessages.length, 1, 'context hook should inject exactly one labeled custom memory message');
assert.equal(first.memoryMessages[0].display, false, 'memory context message should be hidden from transcript display');
assert(first.block.startsWith('<hybrid_memory>'), 'memory block should be a clearly delimited context block');
assert(first.block.includes('untrusted context'), 'memory block should carry an explicit trust-boundary warning');
assert(first.block.includes('local-first, inspectable'), 'project decisions should be selected for relevant prompts');
assert(first.block.includes('npm test'), 'matching validation recipes should be selected');
assert(first.block.includes('qualityMain'), 'repo-map search hints should be selected for symbol/path prompts');
assert(first.block.includes('privacy-safe'), 'pinned user preferences should remain visible');
assert(!first.block.includes('Old stale decision'), 'inactive records should never be injected');
assert(!first.block.includes('Global editor telemetry hook'), 'unrelated global codebase notes should stay out of generic injection');
assert(first.block.length <= 6000, `memory block should stay bounded, got ${first.block.length} characters`);

const second = await contextForPrompt(h, prompt, first.memoryMessages);
assert.equal(second.memoryMessages.length, 1, 'context hook should replace old memory context instead of accumulating duplicates');

await h.emit('before_agent_start', { prompt, systemPrompt: 'base system prompt' });
const stringContext = await h.emit('context', { messages: [stringUserMessage(prompt)] });
const stringBlock = String(stringContext.find((result) => result?.messages)?.messages?.find((message) => message.customType === 'hybrid-memory-context')?.content ?? '');
assert(stringBlock.includes('qualityMain'), 'context prompt extraction should handle both string and structured user-message content');
const fallbackContext = await h.emit('context', { messages: [] });
const fallbackBlock = String(fallbackContext.find((result) => result?.messages)?.messages?.find((message) => message.customType === 'hybrid-memory-context')?.content ?? '');
assert(fallbackBlock.includes('qualityMain'), 'context injection should fall back to the latest before_agent_start prompt if Pi has not appended the current user message yet');

const latencies = [];
for (let i = 0; i < 25; i++) {
  const start = performance.now();
  await contextForPrompt(h, prompt);
  latencies.push(performance.now() - start);
}
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.floor(latencies.length * 0.95)];
assert(p95 < 250, `context injection p95 should stay fast in fixture, got ${p95.toFixed(1)}ms`);

const doctor = await h.tool('hybrid_memory_doctor', { mode: 'preview' });
assert(doctor.details.plan.reviewHints.some((hint) => hint.reason === 'thin-summary-mined-preference'), 'doctor should surface low-context imported preferences as manual review hints');
assert(existsSync(doctor.details.reportPath), 'doctor should write an inspectable curation report');
const report = readFileSync(doctor.details.reportPath, 'utf8');
assert(report.includes('## Preference review hints'), 'doctor report should include a preference review section');
assert(existsSync(join(projectMemoryDir(cwd), 'repomap.json')), 'quality harness should build the repo map artifact');

console.log(`pi-hybrid-memory quality harness ok (context p95 ${p95.toFixed(1)}ms, block ${first.block.length} chars)`);

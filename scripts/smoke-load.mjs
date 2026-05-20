import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const tempRoot = mkdtempSync(join(tmpdir(), 'omp-hybrid-memory-smoke-'));
const home = join(tempRoot, 'home');
const cwd = join(tempRoot, 'project');
const agentDir = join(home, '.omp', 'agent');
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;

const typebox = await import('@oh-my-pi/pi-coding-agent/extensibility/typebox');
const zod = await import('zod/v4');
const extension = (await import(pathToFileURL(join(repoRoot, 'extensions', 'hybrid-memory.ts')).href)).default;

const commands = new Map();
const tools = new Map();
const handlers = new Map();
const notifications = [];
const statuses = [];
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
const ctx = {
  cwd,
  sessionManager: { getSessionFile: () => undefined },
  ui: {
    theme,
    setStatus: (key, value) => statuses.push({ key, value }),
    setWidget: () => undefined,
    notify: (message, level = 'info') => notifications.push({ message, level }),
    custom: async () => undefined,
  },
};

extension({
  typebox,
  zod,
  logger: console,
  pi: {},
  on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  registerCommand: (name, config) => commands.set(name, config),
  registerTool: (config) => tools.set(config.name, config),
});

assert(commands.has('hmemory-health'), 'hmemory-health command should register');
assert(tools.has('hybrid_memory_stats'), 'hybrid_memory_stats tool should register');
for (const handler of handlers.get('session_start') ?? []) await handler({ type: 'session_start' }, ctx);
const stats = await tools.get('hybrid_memory_stats').execute('smoke', {}, undefined, undefined, ctx);
assert.match(stats.content[0].text, /Hybrid memory:/, 'stats tool should execute after session_start');
assert(statuses.some((s) => s.key === 'hybrid-memory'), 'session_start should update status chrome');

console.log('omp-hybrid-memory smoke load ok');

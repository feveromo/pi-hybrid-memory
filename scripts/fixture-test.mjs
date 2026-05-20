import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const pkg = resolve(new URL('..', import.meta.url).pathname);
const tmp = mkdtempSync(join(tmpdir(), 'omp-hybrid-memory-fixture-'));
const home = mkdtempSync(join(tmpdir(), 'omp-hybrid-memory-home-'));
const agentDir = join(home, '.omp', 'agent');
mkdirSync(agentDir, { recursive: true });
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf8', ...opts, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, ...(opts.env ?? {}) } });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
  }
  return result;
}

function makeHarness(cwd) {
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
  const pi = {
    typebox,
    zod,
    logger: console,
    pi: {},
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name, config) => commands.set(name, config),
    registerTool: (config) => tools.set(config.name, config),
  };
  extension(pi);
  return {
    ctx,
    notifications,
    statuses,
    commands,
    command: async (name, args = '') => commands.get(name).handler(args, ctx),
    tool: async (name, params = {}) => tools.get(name).execute('test', params, undefined, () => {}, ctx),
  };
}

const typebox = await import('@oh-my-pi/pi-coding-agent/extensibility/typebox');
const zod = await import('zod/v4');
const extension = (await import(pathToFileURL(join(pkg, 'extensions', 'hybrid-memory.ts')).href)).default;

run('git', ['init', '-q']);
writeFileSync(join(tmp, 'tracked.ts'), 'export const tracked = 1;\n');
run('git', ['add', 'tracked.ts']);
writeFileSync(join(tmp, 'untracked.ts'), 'export const untracked = 2;\n');
mkdirSync(join(tmp, '.omp', 'hybrid-memory'), { recursive: true });
writeFileSync(join(tmp, '.omp', 'hybrid-memory', 'should-not-map.ts'), 'export const runtimeState = true;\n');

const h = makeHarness(tmp);
await h.command('hmemory-repomap');

const map = JSON.parse(readFileSync(join(tmp, '.omp', 'hybrid-memory', 'repomap.json'), 'utf8'));
const paths = map.files.map((f) => f.path).sort();
if (!paths.includes('tracked.ts')) throw new Error('repo map missed tracked file');
if (!paths.includes('untracked.ts')) throw new Error('repo map missed untracked non-ignored file');
if (paths.some((p) => p.startsWith('.omp/'))) throw new Error('repo map included .omp runtime state');

await h.command('hmemory-prune', 'foo');

console.log(`omp-hybrid-memory fixture ok: ${tmp}`);

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const tempRoot = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-behavior-'));
const tempHome = join(tempRoot, 'home');
mkdirSync(tempHome, { recursive: true });
process.env.HOME = tempHome;

function linkPackage(moduleRoot, packageName, target) {
  const link = join(moduleRoot, 'node_modules', ...packageName.split('/'));
  mkdirSync(dirname(link), { recursive: true });
  if (!existsSync(link)) symlinkSync(target, link, 'dir');
}

const moduleRoot = join(tempRoot, 'module');
mkdirSync(moduleRoot, { recursive: true });
const globalNodeModules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const piRoot = join(globalNodeModules, '@earendil-works', 'pi-coding-agent');
linkPackage(moduleRoot, '@earendil-works/pi-ai', join(piRoot, 'node_modules', '@earendil-works', 'pi-ai'));
linkPackage(moduleRoot, '@earendil-works/pi-coding-agent', piRoot);
linkPackage(moduleRoot, '@earendil-works/pi-tui', join(piRoot, 'node_modules', '@earendil-works', 'pi-tui'));
linkPackage(moduleRoot, 'typebox', join(piRoot, 'node_modules', 'typebox'));
const moduleFile = join(moduleRoot, 'hybrid-memory.ts');
copyFileSync(join(repoRoot, 'extensions', 'hybrid-memory.ts'), moduleFile);
const extension = (await import(pathToFileURL(moduleFile).href)).default;

function projectMemoryDir(cwd) {
  return join(cwd, '.pi', 'hybrid-memory');
}

function readRecords(cwd, scope = 'project') {
  const file = scope === 'user'
    ? join(tempHome, '.pi', 'agent', 'memory', 'records.jsonl')
    : join(projectMemoryDir(cwd), 'records.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

function makeHarness(cwd, sessionFile) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const notifications = [];
  const statuses = [];
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const ctx = {
    cwd,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      theme,
      setStatus: (key, value) => statuses.push({ key, value }),
      setWidget: () => {},
      notify: (message, level = 'info') => notifications.push({ message, level }),
      custom: async () => undefined,
    },
  };
  const pi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name, config) => commands.set(name, config),
    registerTool: (config) => tools.set(config.name, config),
  };
  extension(pi);
  return {
    ctx,
    notifications,
    statuses,
    command: async (name, args = '') => commands.get(name).handler(args, ctx),
    tool: async (name, params = {}) => tools.get(name).execute('test', params, undefined, () => {}, ctx),
    emit: async (event, payload = {}) => {
      const out = [];
      for (const handler of handlers.get(event) ?? []) out.push(await handler(payload, ctx));
      return out;
    },
  };
}

function makeProject(name) {
  const cwd = join(tempRoot, name);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

// Pinned status should not override done/stale/superseded suppression.
{
  const cwd = makeProject('pinned-inactive');
  const h = makeHarness(cwd);
  const inactive = [];
  for (const status of ['done', 'stale', 'superseded']) {
    const content = `Obsolete ${status} pinned memory should never be injected`;
    const remembered = await h.tool('hybrid_memory_remember', {
      scope: 'project',
      kind: 'decision',
      subject: `obsolete ${status} pinned memory`,
      content,
      pinned: true,
      salience: 5,
    });
    inactive.push({ status, content, id: remembered.details.id });
    await h.tool('hybrid_memory_forget', { id: remembered.details.id, scope: 'project', status });
  }

  const summary = readFileSync(join(projectMemoryDir(cwd), 'summary.md'), 'utf8');
  const context = readFileSync(join(projectMemoryDir(cwd), 'context.md'), 'utf8');
  for (const item of inactive) {
    assert(!summary.includes(item.content), `${item.status} pinned record should not appear in generated summary`);
    assert(!context.includes(item.content), `${item.status} pinned record should not appear in generated context`);
    const search = await h.tool('hybrid_memory_search', { query: item.content, limit: 10 });
    assert.equal(search.details.hits.length, 0, `${item.status} pinned record should not be returned by search`);
  }

  const before = await h.emit('before_agent_start', { prompt: 'obsolete done stale superseded pinned memory', systemPrompt: 'base' });
  const injected = String(before[0]?.systemPrompt ?? '');
  for (const item of inactive) assert(!injected.includes(item.content), `${item.status} pinned record should not be injected`);
}

// Stored records should redact common tokens and sensitive paths before they hit JSONL.
{
  const cwd = makeProject('redaction');
  const h = makeHarness(cwd);
  const secret = 'sk-proj-' + 'ABCDEFGHIJKLMNOPQRSTUVWX';
  await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'codebase_note',
    subject: 'redaction note',
    content: `Token ${secret} lives beside /tmp/app/.env and must not persist`,
    filePaths: ['fixtures/.ssh/id_ed25519', 'src/index.ts'],
  });
  const raw = readFileSync(join(projectMemoryDir(cwd), 'records.jsonl'), 'utf8');
  assert(!raw.includes(secret), 'OpenAI-style secret should be redacted in storage');
  assert(!raw.includes('/tmp/app/.env'), 'sensitive .env path should be redacted in storage');
  assert(!raw.includes('id_ed25519'), 'sensitive key file path should be removed from filePaths');
  assert(raw.includes('[REDACTED]'), 'redacted secret marker should be stored');
  assert(raw.includes('[REDACTED_PATH]'), 'redacted path marker should be stored');
  assert(raw.includes('src/index.ts'), 'safe file path should be retained');
}

// Auto-capture should keep durable preferences while ignoring one-off wording.
{
  const cwd = makeProject('auto-capture');
  const h = makeHarness(cwd);
  const before = readRecords(cwd, 'user').length;
  await h.emit('before_agent_start', { prompt: 'This temporary fixture should never be injected', systemPrompt: 'base' });
  assert.equal(readRecords(cwd, 'user').length, before, 'one-off never wording should not become a durable preference');
  await h.emit('before_agent_start', { prompt: 'gpt reviewed the extension and said this, fix everything that needs to be fixed please: Overall good. Main Issues: auto-capturing preferences is useful but heuristic. Best Next Fixes: tune it. Verdict: solid prototype with polish needed.'.repeat(2), systemPrompt: 'base' });
  assert.equal(readRecords(cwd, 'user').length, before, 'pasted reviews should not become durable preferences');
  await h.emit('before_agent_start', { prompt: 'remember that I prefer compact answers in tests', systemPrompt: 'base' });
  assert.equal(readRecords(cwd, 'user').length, before + 1, 'explicit remember/prefer prompt should be auto-captured');
}

// Delegated/session-artifact prompts and generic inspection commands should stay out of memory.
{
  const cwd = makeProject('delegated-session-noise');
  const h = makeHarness(cwd);
  const sessionFile = join(tempRoot, 'delegated-session-noise.jsonl');
  const sessionLines = [
    { type: 'session', id: 'delegated-session', cwd, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'You are the orchestrator. Immediately run the subagent tool; do not do the work inline.' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Task: Research this topic and produce a concise, well-sourced brief.' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: "git status --short && find . -maxdepth 2 -type f | sort" } }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done and validated.' }] } },
  ];
  writeFileSync(sessionFile, sessionLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const result = await h.tool('hybrid_memory_import_sessions', { sessionPath: sessionFile });
  assert.equal(result.details.extracted, 0, 'delegated prompts plus generic commands should not create memories');
}

// Useful validation commands should still be remembered as recipes.
{
  const cwd = makeProject('useful-command-session');
  const h = makeHarness(cwd);
  const sessionFile = join(tempRoot, 'useful-command-session.jsonl');
  const sessionLines = [
    { type: 'session', id: 'useful-command-session', cwd, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'please validate this extension' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'npm test && npm run test:fixture' } }] } },
  ];
  writeFileSync(sessionFile, sessionLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const result = await h.tool('hybrid_memory_import_sessions', { sessionPath: sessionFile });
  assert(result.details.extracted >= 1, 'useful validation command session should create memories');
  assert(readRecords(cwd, 'project').some((r) => r.kind === 'recipe' && /npm test/.test(r.content)), 'npm test command should be remembered as a recipe');
}

// Re-importing the same session should not append duplicate records.
{
  const cwd = makeProject('session-dedupe');
  const h = makeHarness(cwd);
  const sessionFile = join(tempRoot, 'session-dedupe.jsonl');
  const sessionLines = [
    { type: 'session', id: 'dedupe-session', cwd, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'remember that I prefer compact test output' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done and validated.' }] } },
  ];
  writeFileSync(sessionFile, sessionLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const first = await h.tool('hybrid_memory_import_sessions', { sessionPath: sessionFile });
  const afterFirst = readRecords(cwd, 'project').length + readRecords(cwd, 'user').length;
  const second = await h.tool('hybrid_memory_import_sessions', { sessionPath: sessionFile });
  const afterSecond = readRecords(cwd, 'project').length + readRecords(cwd, 'user').length;
  assert(first.details.written > 0, 'first session import should write records');
  assert.equal(second.details.written, 0, 'second session import should dedupe identical records');
  assert.equal(afterSecond, afterFirst, 'second session import should not append JSONL duplicates');
}

// Repo-map staleness should detect files added after map generation.
{
  const cwd = makeProject('repo-staleness');
  execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'tracked.ts'), 'export const tracked = 1;\n');
  execFileSync('git', ['add', 'tracked.ts'], { cwd });
  const h = makeHarness(cwd);
  await h.command('hmemory-repomap');
  writeFileSync(join(cwd, 'added.ts'), 'export const added = 2;\n');
  await h.command('hmemory-context');
  const context = readFileSync(join(projectMemoryDir(cwd), 'context.md'), 'utf8');
  assert(context.includes('added.ts added after repo map generation'), 'context should report added files as stale');
}

// Pi settings should tune injection section limits without changing code.
{
  const cwd = makeProject('settings-tuning');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({
    hybridMemory: {
      maxInjectChars: 2000,
      injectSectionLimits: { 'User Preferences': 1 },
      pruneActiveSessionRecaps: 14,
    },
  }, null, 2) + '\n', 'utf8');
  const h = makeHarness(cwd);
  await h.tool('hybrid_memory_remember', {
    scope: 'user',
    kind: 'preference',
    subject: 'alpha configured preference',
    content: 'Alpha configured preference should be the only injected user preference',
    pinned: true,
    salience: 5,
  });
  await h.tool('hybrid_memory_remember', {
    scope: 'user',
    kind: 'preference',
    subject: 'beta configured preference',
    content: 'Beta configured preference should be hidden by the section limit',
    pinned: true,
    salience: 5,
  });
  const before = await h.emit('before_agent_start', { prompt: 'configured preference lookup', systemPrompt: 'base' });
  const injected = String(before[0]?.systemPrompt ?? '');
  assert(injected.includes('Alpha configured preference'), 'configured section limit should still include the first preference');
  assert(!injected.includes('Beta configured preference'), 'configured section limit should cap user preferences');
  await h.command('hmemory-config');
  assert(h.notifications.some((n) => /"pruneActiveSessionRecaps": 14/.test(n.message)), '/hmemory-config should show effective configured values');
}

// Repo-map building should stay bounded on larger repositories.
{
  const cwd = makeProject('large-repo-smoke');
  execFileSync('git', ['init', '-q'], { cwd });
  for (let i = 0; i < 1700; i++) {
    const dir = join(cwd, 'src', String(i % 25));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file-${i}.ts`), `export const symbol${i} = ${i};\n`, 'utf8');
  }
  const h = makeHarness(cwd);
  const start = performance.now();
  await h.command('hmemory-repomap');
  const elapsedMs = performance.now() - start;
  const map = JSON.parse(readFileSync(join(projectMemoryDir(cwd), 'repomap.json'), 'utf8'));
  assert.equal(map.files.length, 1500, 'large repo smoke should obey the default repo-map file cap');
  assert(elapsedMs < 8000, `large repo-map smoke should stay bounded, took ${elapsedMs.toFixed(0)}ms`);
}

console.log('pi-hybrid-memory behavior tests ok');

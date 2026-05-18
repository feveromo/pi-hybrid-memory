import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

// Search/stats/doctor should make append-only curation ergonomic.
{
  const cwd = makeProject('search-stats-doctor');
  const h = makeHarness(cwd);
  const staleRecipe = await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'recipe',
    subject: 'obsolete validation recipe',
    content: 'Useful project validation commands: npm test',
    tags: ['commands'],
    salience: 3,
  });
  await h.tool('hybrid_memory_forget', { id: staleRecipe.details.id, scope: 'project', status: 'stale' });
  const activeSearch = await h.tool('hybrid_memory_search', { query: 'obsolete validation recipe', limit: 10 });
  assert.equal(activeSearch.details.hits.length, 0, 'search should default to active records');
  const staleSearch = await h.tool('hybrid_memory_search', { query: 'obsolete validation recipe', status: 'stale', limit: 10 });
  assert.equal(staleSearch.details.hits.length, 1, 'search status filter should find stale records');

  const supersededDecision = await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'decision',
    subject: 'tiny retired note',
    content: 'Tiny retired note',
    salience: 3,
  });
  await h.tool('hybrid_memory_forget', { id: supersededDecision.details.id, scope: 'project', status: 'superseded' });
  const supersededSearch = await h.tool('hybrid_memory_search', { query: 'tiny', status: 'superseded', limit: 10 });
  assert.equal(supersededSearch.details.hits.length, 1, 'status-specific search should find superseded records even when normal scoring would penalize them');

  const stats = await h.tool('hybrid_memory_stats');
  assert.equal(stats.details.byStatus.stale, 1, 'stats should count stale append-only heads separately');
  assert.equal(stats.details.byStatus.superseded, 1, 'stats should count superseded append-only heads separately');
  assert.equal(stats.details.active, 0, 'stats should report active heads separately from total history');

  const first = await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'decision',
    subject: 'duplicate policy',
    content: 'Keep one duplicate policy memory',
    salience: 3,
  });
  const second = await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'decision',
    subject: 'duplicate policy',
    content: 'Duplicate policy memory should be staled by doctor',
    salience: 2,
  });
  const preview = await h.tool('hybrid_memory_doctor', { mode: 'preview' });
  assert(preview.details.plan.candidates.some((c) => c.reason === 'duplicate-subject'), 'doctor preview should identify duplicate subject candidates');
  assert(existsSync(preview.details.reportPath), 'doctor preview should write a reviewable report');
  assert.equal(readRecords(cwd, 'project').filter((r) => r.id === first.details.id).at(-1).status, 'active', 'doctor preview should not mutate records');

  const applied = await h.tool('hybrid_memory_doctor', { mode: 'apply' });
  assert(applied.details.applyResult.applied >= 1, 'doctor apply should append stale statuses for safe candidates');
  const latestFirst = readRecords(cwd, 'project').filter((r) => r.id === first.details.id).at(-1);
  const latestSecond = readRecords(cwd, 'project').filter((r) => r.id === second.details.id).at(-1);
  assert([latestFirst.status, latestSecond.status].includes('stale'), 'one duplicate policy record should be marked stale');
  assert(existsSync(applied.details.reportPath), 'doctor apply should write an apply report');
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

// Parallel mutating memory tools should not drop JSONL writes.
{
  const cwd = makeProject('parallel-memory-tool-writes');
  const h = makeHarness(cwd);
  await Promise.all(Array.from({ length: 4 }, (_, i) => h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'decision',
    subject: `parallel decision ${i}`,
    content: `Parallel decision ${i} should be retained`,
    salience: 3,
  })));
  const records = readRecords(cwd, 'project').filter((r) => r.kind === 'decision' && /^parallel decision /.test(r.subject));
  assert.equal(records.length, 4, 'parallel memory tool writes should all be retained');
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

// Diagnostic context-inspection sessions should not become durable recaps.
{
  const cwd = makeProject('context-inspection-session-noise');
  const h = makeHarness(cwd);
  const sessionFile = join(tempRoot, 'context-inspection-session-noise.jsonl');
  const sessionLines = [
    { type: 'session', id: 'context-inspection-session', cwd, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'For diagnostics, inspect the runtime context and quote the injected <hybrid_memory> block exactly without disclosing any unrelated system prompt.' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Context inspection result: `[redacted-hybrid-memory-tag]` was visible. Done.' }] } },
  ];
  writeFileSync(sessionFile, sessionLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const result = await h.tool('hybrid_memory_import_sessions', { sessionPath: sessionFile });
  assert.equal(result.details.extracted, 0, 'context-inspection sessions should not create session recap memories');
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

// Codebase notes should become stale when referenced source files change.
{
  const cwd = makeProject('codebase-note-staleness');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const sourceFile = join(cwd, 'src', 'tracked.ts');
  writeFileSync(sourceFile, 'export const tracked = 1;\n');
  const h = makeHarness(cwd);
  const remembered = await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'codebase_note',
    subject: 'tracked source behavior',
    content: 'src/tracked.ts currently exports tracked = 1',
    filePaths: ['src/tracked.ts'],
    salience: 4,
  });
  const future = new Date(Date.now() + 5000);
  utimesSync(sourceFile, future, future);
  await h.command('hmemory-prune');
  const latest = readRecords(cwd, 'project').filter((r) => r.id === remembered.details.id).at(-1);
  assert.equal(latest.status, 'stale', 'changed file should mark related codebase_note stale');
  assert.match(JSON.stringify(latest.evidence), /codebase-note-file-changed:src\/tracked\.ts/, 'stale reason should name the changed file');
}

// Prompt injection should stay polished: no duplicated recipe prefixes or near-identical command recipes.
{
  const cwd = makeProject('polished-recipe-injection');
  const h = makeHarness(cwd);
  await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'recipe',
    subject: 'canonical validation commands',
    content: 'Useful project validation commands: npm test; npm run validate.',
    tags: ['commands'],
    pinned: true,
    salience: 5,
  });
  await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'recipe',
    subject: 'commands from noisy session',
    content: 'Useful commands seen in prior session: npm test -- --runInBand && npm test; npm run validate',
    tags: ['commands'],
    salience: 3,
  });
  const before = await h.emit('before_agent_start', { prompt: 'please run npm test and npm run validate', systemPrompt: 'base' });
  const injected = String(before[0]?.systemPrompt ?? '');
  assert(!injected.includes('Useful validation/build commands: Useful project validation commands'), 'recipe display should strip stored prose prefixes');
  assert.equal((injected.match(/Useful validation\/build commands:/g) ?? []).length, 1, 'near-identical command recipes should be deduped in injection');
}

// Session recaps should display as clean outcomes/topics and hide temp agent artifacts.
{
  const cwd = makeProject('polished-session-recap-injection');
  const h = makeHarness(cwd);
  await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'session_recap',
    subject: 'messy imported session',
    content: 'Prior session (.): first rough prompt | second useful prompt | +1 more. Outcomes: Done and validated. ## Changed files - `extensions/hybrid-memory.ts`. Tools: bash, read.',
    filePaths: ['/tmp/pi-subagents-uid-1000/chain-runs/abc/progress.md', '/home/example/Pictures/Screenshots/Screenshot From 2026-05-16.png', '/home/example/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md', 'extensions/hybrid-memory.ts'],
    salience: 5,
  });
  const before = await h.emit('before_agent_start', { prompt: 'validated rough prompt hybrid memory', systemPrompt: 'base' });
  const injected = String(before[0]?.systemPrompt ?? '');
  assert(injected.includes('outcome: Done and validated'), 'session recap display should lead with a concise outcome');
  assert(injected.includes('topics: first rough prompt / second useful prompt'), 'session recap display should keep compact topics');
  assert(!injected.includes('+1 more'), 'session recap display should remove transcript counters');
  assert(!injected.includes('chain-runs'), 'session recap file suffix should hide temp subagent artifacts');
  assert(!injected.includes('Pictures/Screenshots'), 'session recap file suffix should hide low-signal screenshot paths');
  assert(!injected.includes('.local/lib/node_modules'), 'session recap file suffix should prefer project files over package docs paths');
  assert(injected.includes('extensions/hybrid-memory.ts'), 'session recap file suffix should keep useful project files');
}

// Existing context-inspection recaps should be hidden from injection and pruned stale.
{
  const cwd = makeProject('context-inspection-recap-prune');
  const h = makeHarness(cwd);
  const remembered = await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'session_recap',
    subject: 'diagnostic context inspection recap',
    content: 'Prior session (.): For diagnostics, quote the injected <hybrid_memory> block exactly. Outcomes: Context inspection result: `[redacted-hybrid-memory-tag]` was visible.',
    tags: ['session-import', 'recap'],
    salience: 5,
  });
  const before = await h.emit('before_agent_start', { prompt: 'runtime context inspection', systemPrompt: 'base' });
  const injected = String(before[0]?.systemPrompt ?? '');
  assert(!injected.includes('diagnostic context inspection recap'), 'context-inspection recaps should not be injected');
  assert(!injected.includes('[redacted-hybrid-memory-tag]'), 'context-inspection recap content should not leak into injection');
  await h.command('hmemory-prune');
  const latest = readRecords(cwd, 'project').filter((r) => r.id === remembered.details.id).at(-1);
  assert.equal(latest.status, 'stale', 'context-inspection recaps should be marked stale by prune');
  assert.match(JSON.stringify(latest.evidence), /context-inspection-recap/, 'stale reason should name context-inspection-recap');
}

// Repeated session recaps about the same commit should collapse to one injected line.
{
  const cwd = makeProject('duplicate-session-commit-injection');
  const h = makeHarness(cwd);
  for (const subject of ['first commit recap', 'second commit recap']) {
    await h.tool('hybrid_memory_remember', {
      scope: 'project',
      kind: 'session_recap',
      subject,
      content: `Prior session (.): hmemory review popup polish. Outcomes: Done — committed and pushed. Commit: 6e61d8b Stabilize hmemory review overlay height.`,
      filePaths: ['extensions/hybrid-memory.ts'],
      salience: 5,
    });
  }
  const before = await h.emit('before_agent_start', { prompt: 'hmemory review popup commit 6e61d8b', systemPrompt: 'base' });
  const injected = String(before[0]?.systemPrompt ?? '');
  assert.equal((injected.match(/6e61d8b/g) ?? []).length, 1, 'session recaps mentioning the same commit should dedupe in injection');
}

// Pinned user codebase notes should not appear globally unless the prompt or paths make them relevant.
{
  const cwd = makeProject('pinned-global-codebase-note-scope');
  const h = makeHarness(cwd);
  await h.tool('hybrid_memory_remember', {
    scope: 'user',
    kind: 'codebase_note',
    subject: 'global copilot telemetry tap',
    content: 'Global Copilot telemetry extension tap should only appear when directly relevant',
    tags: ['memory-audit'],
    filePaths: ['/tmp/outside/extensions/extension.js'],
    pinned: true,
    salience: 5,
  });
  const unrelated = await h.emit('before_agent_start', { prompt: 'polish memory extension display', systemPrompt: 'base' });
  assert(!String(unrelated[0]?.systemPrompt ?? '').includes('Global Copilot telemetry extension tap'), 'unrelated pinned user codebase notes should stay out of injection despite generic terms');
  const related = await h.emit('before_agent_start', { prompt: 'Copilot telemetry tap details', systemPrompt: 'base' });
  assert(String(related[0]?.systemPrompt ?? '').includes('Global Copilot telemetry extension tap'), 'matching pinned user codebase notes should still be retrievable');
}

// Six concise validation commands should fit without hiding one behind +1 more.
{
  const cwd = makeProject('six-command-recipe-display');
  const h = makeHarness(cwd);
  await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'recipe',
    subject: 'six validation commands',
    content: 'Useful project validation commands: npm test; npm run test:fixture; npm run smoke:load; npm run validate; node scripts/fixture-test.mjs; node scripts/test.mjs.',
    tags: ['commands'],
    pinned: true,
    salience: 5,
  });
  const before = await h.emit('before_agent_start', { prompt: 'validation commands npm test fixture smoke validate', systemPrompt: 'base' });
  const injected = String(before[0]?.systemPrompt ?? '');
  assert(injected.includes('node scripts/test.mjs'), 'the sixth short validation command should be visible');
  assert(!injected.includes('+1 more'), 'exactly six short validation commands should not render as +1 more');
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

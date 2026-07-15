import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const tempRoot = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-behavior-'));
process.once('exit', () => rmSync(tempRoot, { recursive: true, force: true }));
const tempHome = join(tempRoot, 'home');
mkdirSync(tempHome, { recursive: true });
process.env.HOME = tempHome;
const sessionRoot = join(tempHome, '.pi', 'agent', 'sessions', 'tests');
mkdirSync(sessionRoot, { recursive: true });

const moduleFile = join(repoRoot, 'extensions', 'hybrid-memory.ts');
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
  let activeTools = [];
  const handlers = new Map();
  const notifications = [];
  const statuses = [];
  const widgets = [];
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const ctx = {
    cwd,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      theme,
      setStatus: (key, value) => statuses.push({ key, value }),
      setWidget: (key, value) => widgets.push({ key, value }),
      notify: (message, level = 'info') => notifications.push({ message, level }),
      custom: async () => undefined,
    },
  };
  const pi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerCommand: (name, config) => commands.set(name, config),
    registerTool: (config) => {
      tools.set(config.name, config);
      if (!activeTools.includes(config.name)) activeTools.push(config.name);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...tools.values()].map((tool) => ({ name: tool.name })),
    setActiveTools: (names) => { activeTools = [...names]; },
  };
  extension(pi);
  return {
    ctx,
    notifications,
    statuses,
    widgets,
    commands,
    activeTools: () => [...activeTools],
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

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

async function injectedForPrompt(h, prompt) {
  await h.emit('before_agent_start', { prompt, systemPrompt: 'base' });
  const context = await h.emit('context', { messages: [userMessage(prompt)] });
  const messages = context.find((result) => result?.messages)?.messages ?? [];
  const memory = messages.find((message) => message.role === 'custom' && message.customType === 'hybrid-memory-context');
  return String(memory?.content ?? '');
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

  const injected = await injectedForPrompt(h, 'obsolete done stale superseded pinned memory');
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
  await h.tool('hybrid_memory_remember', {
    scope: 'user',
    kind: 'preference',
    subject: 'commit message should be useful later',
    content: 'Commit message should be useful later',
    tags: ['compaction', 'summary-mined'],
    salience: 2,
  });
  const preview = await h.tool('hybrid_memory_doctor', { mode: 'preview' });
  assert(preview.details.plan.candidates.some((c) => c.reason === 'duplicate-subject'), 'doctor preview should identify duplicate subject candidates');
  assert(preview.details.plan.reviewHints.some((h) => h.reason === 'thin-summary-mined-preference'), 'doctor preview should flag low-context summary-mined preferences for manual review');
  assert(existsSync(preview.details.reportPath), 'doctor preview should write a reviewable report');
  assert.equal(readRecords(cwd, 'project').filter((r) => r.id === first.details.id).at(-1).status, 'active', 'doctor preview should not mutate records');

  const applied = await h.tool('hybrid_memory_doctor', { mode: 'apply' });
  assert(applied.details.applyResult.applied >= 1, 'doctor apply should append stale statuses for safe candidates');
  const latestFirst = readRecords(cwd, 'project').filter((r) => r.id === first.details.id).at(-1);
  const latestSecond = readRecords(cwd, 'project').filter((r) => r.id === second.details.id).at(-1);
  assert([latestFirst.status, latestSecond.status].includes('stale'), 'one duplicate policy record should be marked stale');
  assert(existsSync(applied.details.reportPath), 'doctor apply should write an apply report');
}

// Exact package searches and forget flows should be low-noise and honest about append-only status.
{
  const cwd = makeProject('exact-search-forget');
  const h = makeHarness(cwd);
  assert(!h.commands.has('hmemory-widget'), 'the persistent hmemory widget command should stay removed');
  await h.emit('session_start');
  await h.emit('resources_discover');
  assert(h.widgets.some((w) => w.key === 'hybrid-memory' && w.value === undefined), 'startup/reload should clear any previously displayed hybrid-memory widget');

  const exact = await h.tool('hybrid_memory_remember', {
    scope: 'user',
    kind: 'decision',
    subject: 'Remove retired helper package',
    content: 'Removed npm:@example/retired-helper-package from the agent setup; its optional service should stay disabled.',
    tags: ['package', 'helper', 'service'], 
    salience: 4,
  });
  const generic = await h.tool('hybrid_memory_remember', {
    scope: 'user',
    kind: 'preference',
    subject: 'Review and patch important Pi extensions before relying on them',
    content: 'When installing important Pi extensions, inspect source and validate instead of blindly installing.',
    tags: ['pi', 'extension'],
    pinned: true,
    salience: 4,
  });
  const search = await h.tool('hybrid_memory_search', { query: '@example/retired-helper-package optional service package', includeInactive: true, limit: 10 });
  assert.equal(search.details.hits[0].record.id, exact.details.id, 'exact package records should outrank generic extension memories');
  assert(!search.details.hits.some((h) => h.record.id === generic.details.id), 'strong package queries should filter unrelated generic extension memories');

  const forgot = await h.tool('hybrid_memory_forget', {
    id: exact.details.id,
    scope: 'user',
    status: 'stale',
    tombstone: true,
    tombstoneNote: 'Do not suggest the retired helper package unless explicitly requested.',
  });
  assert.match(forgot.content[0].text, /append-only history retained, not hard-deleted/, 'forget result should explain stale vs hard delete');
  assert(forgot.details.tombstone, 'forget can keep a tiny do-not-suggest tombstone when requested');
  assert.equal(readRecords(cwd, 'user').filter((r) => r.id === exact.details.id).at(-1).status, 'stale', 'forgotten record should be stale');
  assert(readRecords(cwd, 'user').some((r) => r.kind === 'preference' && r.status === 'active' && /retired helper package/.test(r.content)), 'tombstone should preserve the negative preference without reactivating old details');
  await h.tool('hybrid_memory_forget', { id: generic.details.id, scope: 'user', status: 'stale' });
  await h.tool('hybrid_memory_forget', { id: forgot.details.tombstone.id, scope: 'user', status: 'stale' });

  await h.command('hmemory-forget', '@example/retired-helper-package stale');
  assert.match(h.notifications.at(-1).message, /Matching active memories|No record found/, 'query forget should preview candidates instead of pretending to delete raw history');
}

// Explicit purge should hard-delete JSONL history only when --force is present.
{
  const cwd = makeProject('purge-hard-delete');
  const h = makeHarness(cwd);
  const remembered = await h.tool('hybrid_memory_remember', {
    scope: 'project',
    kind: 'decision',
    subject: 'temporary purge target',
    content: 'Temporary purge target content should vanish from JSONL',
    salience: 3,
  });
  await h.tool('hybrid_memory_forget', { id: remembered.details.id, scope: 'project', status: 'stale' });
  const recordsFile = join(projectMemoryDir(cwd), 'records.jsonl');
  appendFileSync(recordsFile, JSON.stringify({ schemaVersion: 0, id: remembered.details.id, scope: 'project', content: 'legacy target version' }) + '\n', 'utf8');
  appendFileSync(recordsFile, '{ unrelated damaged line\n', 'utf8');
  await h.command('hmemory-purge', `project:${remembered.details.id}`);
  assert(readFileSync(recordsFile, 'utf8').includes('Temporary purge target content'), 'purge without --force should not rewrite JSONL');
  await h.command('hmemory-purge', `project:${remembered.details.id} --force`);
  const raw = readFileSync(recordsFile, 'utf8');
  assert(!raw.includes('Temporary purge target content'), 'forced purge should remove raw record content from JSONL');
  assert(!raw.includes('legacy target version'), 'forced purge should remove older-schema target versions');
  assert(!raw.includes(remembered.details.id), 'forced purge should remove every scoped target id from JSONL');
  assert(raw.includes('unrelated damaged line'), 'forced purge should preserve unrelated damaged JSONL lines');
  assert(!readFileSync(join(projectMemoryDir(cwd), 'summary.md'), 'utf8').includes('Temporary purge target content'), 'forced purge should regenerate summaries');
  assert.match(h.notifications.at(-1).message, /removed 3 JSONL entries.*Audit marker:/, 'forced purge should remove every target version and write a content-free audit marker');
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

// Auto-capture should keep durable preferences while ignoring one-off wording and honoring config.
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

  const offCwd = makeProject('auto-capture-off');
  mkdirSync(join(offCwd, '.pi'), { recursive: true });
  writeFileSync(join(offCwd, '.pi', 'settings.json'), JSON.stringify({ hybridMemory: { autoCapture: { preferences: 'off' } } }), 'utf8');
  const off = makeHarness(offCwd);
  const beforeOff = readRecords(offCwd, 'user').length;
  await off.emit('before_agent_start', { prompt: 'remember that I prefer no auto capture here', systemPrompt: 'base' });
  assert.equal(readRecords(offCwd, 'user').length, beforeOff, 'auto-capture off should not store even explicit remember prompts');

  const heuristicCwd = makeProject('auto-capture-heuristic');
  mkdirSync(join(heuristicCwd, '.pi'), { recursive: true });
  writeFileSync(join(heuristicCwd, '.pi', 'settings.json'), JSON.stringify({ hybridMemory: { autoCapture: { preferences: 'heuristic' } } }), 'utf8');
  const heuristic = makeHarness(heuristicCwd);
  const beforeHeuristic = readRecords(heuristicCwd, 'user').length;
  await heuristic.emit('before_agent_start', { prompt: 'i like compact fixture answers', systemPrompt: 'base' });
  assert.equal(readRecords(heuristicCwd, 'user').length, beforeHeuristic + 1, 'heuristic auto-capture mode should keep broader preference wording');
}

// The enabled toggle should disable automatic injection/capture/import and remove agent tools without deleting data.
{
  const cwd = makeProject('hybrid-memory-toggle-disabled');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ hybridMemory: { enabled: false } }, null, 2) + '\n', 'utf8');
  const h = makeHarness(cwd);
  await h.emit('session_start');
  assert(!h.activeTools().some((name) => name.startsWith('hybrid_memory_')), 'disabled hybrid memory should remove agent-callable memory tools');
  const before = readRecords(cwd, 'user').length;
  const disabledBefore = await h.emit('before_agent_start', { prompt: 'remember that I prefer disabled memory tests', systemPrompt: 'base' });
  const disabledContext = await h.emit('context', { messages: [userMessage('remember that I prefer disabled memory tests')] });
  assert.equal(readRecords(cwd, 'user').length, before, 'disabled hybrid memory should not auto-capture prompts');
  assert.equal(disabledBefore[0], undefined, 'disabled hybrid memory should not modify the pre-agent prompt');
  assert.equal(disabledContext[0], undefined, 'disabled hybrid memory should not inject prompt context');
  const disabledTool = await h.tool('hybrid_memory_stats');
  assert.equal(disabledTool.details.disabled, true, 'disabled hybrid memory tools should explain that the feature is off if called from stale context');

  await h.command('hmemory-toggle', 'on --project');
  assert(h.activeTools().some((name) => name === 'hybrid_memory_search'), 're-enabling should restore hybrid memory tools without requiring reload');
  await h.emit('before_agent_start', { prompt: 'remember that I prefer reenabled memory tests', systemPrompt: 'base' });
  assert.equal(readRecords(cwd, 'user').length, before + 1, 'reenabled hybrid memory should capture prompts again');
  await h.command('hmemory-toggle', 'off --project');
  assert(!h.activeTools().some((name) => name.startsWith('hybrid_memory_')), 'turning hybrid memory back off should remove tools again');
}

// Delegated/session-artifact prompts and generic inspection commands should stay out of memory.
{
  const cwd = makeProject('delegated-session-noise');
  const h = makeHarness(cwd);
  const sessionFile = join(sessionRoot, 'delegated-session-noise.jsonl');
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
  const sessionFile = join(sessionRoot, 'context-inspection-session-noise.jsonl');
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
  const sessionFile = join(sessionRoot, 'useful-command-session.jsonl');
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

// Current live-session auto-import should avoid command-recipe churn while preserving recaps.
{
  const cwd = makeProject('current-session-no-recipe-churn');
  const sessionFile = join(sessionRoot, 'current-session-no-recipe-churn.jsonl');
  const sessionLines = [
    { type: 'session', id: 'current-no-recipe-session', cwd, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'please validate this extension' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'npm test && npm run test:fixture' } }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done and validated.' }] } },
  ];
  writeFileSync(sessionFile, sessionLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const h = makeHarness(cwd, sessionFile);
  await h.emit('agent_end');
  const liveRecords = readRecords(cwd, 'project');
  assert(liveRecords.some((r) => r.kind === 'session_recap'), 'current live-session auto-import should still write a compact recap');
  assert(!liveRecords.some((r) => r.kind === 'recipe'), 'current live-session auto-import should not create command recipes every turn');

  const explicit = await h.tool('hybrid_memory_import_sessions', { sessionPath: sessionFile });
  assert(explicit.details.written >= 1, 'explicit session import should still mine useful command recipes');
  assert(readRecords(cwd, 'project').some((r) => r.kind === 'recipe' && /npm test/.test(r.content)), 'explicit import should preserve command recipe mining');
}

// Re-importing the same session should not append duplicate records.
{
  const cwd = makeProject('session-dedupe');
  const h = makeHarness(cwd);
  const sessionFile = join(sessionRoot, 'session-dedupe.jsonl');
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

// Re-importing a stable session should append when meaningful metadata changes.
{
  const cwd = makeProject('session-meaningful-update');
  const h = makeHarness(cwd);
  const sessionFile = join(sessionRoot, 'session-meaningful-update.jsonl');
  const baseLines = [
    { type: 'session', id: 'meaningful-update-session', cwd, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'please review the meaningful update path' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'src/old.ts' } }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Done and validated.' }] } },
  ];
  writeFileSync(sessionFile, baseLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const first = await h.tool('hybrid_memory_import_sessions', { sessionPath: sessionFile });
  assert(first.details.written > 0, 'first stable session import should write records');

  const updatedLines = [...baseLines];
  updatedLines.splice(3, 0, { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'src/new.ts' } }] } });
  writeFileSync(sessionFile, updatedLines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const second = await h.tool('hybrid_memory_import_sessions', { sessionPath: sessionFile });
  const recapHeads = readRecords(cwd, 'project').filter((r) => r.kind === 'session_recap' && r.subject === 'session meaningful-update-session');
  assert.equal(second.details.written, 1, 'changed session file paths should append a refreshed record head');
  assert(recapHeads.at(-1).filePaths.includes('src/new.ts'), 'refreshed session recap should retain updated file path metadata');
}

// Hand-edited JSONL records should be normalized before stats/search use them.
{
  const cwd = makeProject('manual-jsonl-normalization');
  const dir = projectMemoryDir(cwd);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  writeFileSync(join(dir, 'records.jsonl'), JSON.stringify({
    id: 'manual-invalid-status',
    schemaVersion: 1,
    scope: 'project',
    kind: 'decision',
    subject: 'manual bad status',
    content: 'Manual bad status memory should still be searchable',
    tags: 'not-array',
    status: 'weird',
    salience: 99,
    createdAt: ts,
    updatedAt: ts,
  }) + '\n', 'utf8');
  const h = makeHarness(cwd);
  const stats = await h.tool('hybrid_memory_stats');
  assert.equal(stats.details.statusByScope.project.active, 1, 'invalid status should be coerced to active instead of poisoning project counts');
  assert(stats.details.activeByKind.decision >= 1, 'valid kind should remain counted after normalization');
  const search = await h.tool('hybrid_memory_search', { query: 'manual bad status searchable', limit: 5 });
  assert.equal(search.details.hits.length, 1, 'normalized manual record should be searchable');
  assert.equal(search.details.hits[0].record.salience, 5, 'salience should be clamped to the record max');
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

// Automatic repo-map injection should avoid generic prompt pollution but keep exact path matches.
{
  const cwd = makeProject('repo-auto-injection-strictness');
  execFileSync('git', ['init', '-q'], { cwd });
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'hybrid-memory.ts'), 'export const hybridFeature = 1;\n');
  execFileSync('git', ['add', 'src/hybrid-memory.ts'], { cwd });
  const h = makeHarness(cwd);
  await h.command('hmemory-repomap');
  const generic = await injectedForPrompt(h, 'review memory implementation');
  assert(!generic.includes('## Repo Map Matches'), 'generic memory prompts should not auto-inject repo-map matches');
  const exact = await injectedForPrompt(h, 'inspect src/hybrid-memory.ts hybridFeature');
  assert(exact.includes('src/hybrid-memory.ts'), 'path/symbol prompts should still auto-inject repo-map matches');
}

// Injection truncation and dense path suffixes should read cleanly.
{
  const cwd = makeProject('polished-injection-omissions');
  const h = makeHarness(cwd);
  for (let i = 1; i <= 6; i++) {
    await h.tool('hybrid_memory_remember', {
      scope: 'project',
      kind: 'decision',
      subject: `polished decision ${i}`,
      content: `Polished decision ${i} should be injected cleanly`,
      filePaths: i === 1 ? ['one.ts', 'two.ts', 'three.ts', 'four.ts', 'five.ts', 'six.ts'] : [],
      pinned: true,
      salience: 5,
    });
  }
  const injected = await injectedForPrompt(h, 'polished preference injection display');
  assert(injected.includes('…1 additional lower-ranked record omitted'), 'truncation should explain how many lower-ranked records were omitted');
  assert(!injected.includes('…truncated'), 'injection should avoid abrupt raw truncated markers');
  assert(injected.includes('one.ts, two.ts, three.ts, four.ts, five.ts; 1 more path'), 'long file suffixes should cap inline paths and summarize the rest');
}

// Repo-map matches should be labeled as search hints and filter junk symbols.
{
  const cwd = makeProject('repo-map-polished-hints');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'noisy.ts'), 'export const noisyMagic = 1;\n');
  mkdirSync(projectMemoryDir(cwd), { recursive: true });
  writeFileSync(join(projectMemoryDir(cwd), 'repomap.json'), JSON.stringify({
    schemaVersion: 1,
    root: cwd,
    generatedAt: new Date(Date.now() + 2000).toISOString(),
    files: [{
      path: 'src/noisy.ts',
      kind: 'code',
      symbols: ['in', 'and', 'class', 'to', 'noisyMagic'],
      imports: [],
      size: 29,
    }],
  }, null, 2) + '\n', 'utf8');
  const h = makeHarness(cwd);
  const injected = await injectedForPrompt(h, 'inspect src/noisy.ts noisyMagic');
  assert(injected.includes('Codebase search hints from the current working tree; may be noisy or stale.'), 'repo-map injection should label matches as search hints');
  assert(injected.includes('symbols: noisyMagic'), 'repo-map injection should keep useful symbols');
  assert(!injected.includes('symbols: in, and, class'), 'repo-map injection should filter junk symbols');
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
  const storedBefore = readRecords(cwd, 'project').find((r) => r.id === remembered.details.id);
  assert.equal(storedBefore.evidence.files[0].path, 'src/tracked.ts', 'codebase notes should store file freshness evidence');
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
  const injected = await injectedForPrompt(h, 'please run npm test and npm run validate');
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
    filePaths: ['/tmp/pi-subagents-uid-1000/chain-runs/abc/progress.md', '/tmp/example/captures/synthetic.png', '/tmp/example/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md', 'extensions/hybrid-memory.ts'],
    salience: 5,
  });
  const injected = await injectedForPrompt(h, 'validated rough prompt hybrid memory');
  assert(injected.includes('outcome: Done and validated'), 'session recap display should lead with a concise outcome');
  assert(injected.includes('topics: first rough prompt / second useful prompt'), 'session recap display should keep compact topics');
  assert(!injected.includes('+1 more'), 'session recap display should remove transcript counters');
  assert(!injected.includes('chain-runs'), 'session recap file suffix should hide temp subagent artifacts');
  assert(!injected.includes('synthetic.png'), 'session recap file suffix should hide low-signal media paths');
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
  const injected = await injectedForPrompt(h, 'runtime context inspection');
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
      content: `Prior session (.): settings panel polish. Outcomes: Done and validated. Commit: abc1234 Stabilize settings panel height.`,
      filePaths: ['extensions/hybrid-memory.ts'],
      salience: 5,
    });
  }
  const injected = await injectedForPrompt(h, 'settings panel commit abc1234');
  assert.equal((injected.match(/abc1234/g) ?? []).length, 1, 'session recaps mentioning the same commit should dedupe in injection');
}

// Pinned user decisions/facts should render in their own global section and generated context.
{
  const cwd = makeProject('global-decision-injection');
  const h = makeHarness(cwd);
  await h.tool('hybrid_memory_remember', {
    scope: 'user',
    kind: 'decision',
    subject: 'global package policy',
    content: 'Global package policy should be visible as a user decision',
    pinned: true,
    salience: 5,
  });
  const injected = await injectedForPrompt(h, 'unrelated prompt still includes pinned decisions');
  assert(injected.includes('## Global Decisions/Facts'), 'user decisions should render in a global decision section');
  assert(injected.includes('Global package policy should be visible'), 'pinned user decisions should not disappear after selection');
  await h.command('hmemory-context');
  const context = readFileSync(join(projectMemoryDir(cwd), 'context.md'), 'utf8');
  assert(context.includes('## Global decisions/facts'), 'generated context should include user-scoped decisions/facts');
}

// Pinned user codebase notes should not appear globally unless the prompt or paths make them relevant.
{
  const cwd = makeProject('pinned-global-codebase-note-scope');
  const h = makeHarness(cwd);
  await h.tool('hybrid_memory_remember', {
    scope: 'user',
    kind: 'codebase_note',
    subject: 'global editor telemetry hook',
    content: 'Global editor telemetry hook should only appear when directly relevant',
    tags: ['memory-audit'],
    filePaths: ['/tmp/outside/extensions/extension.js'],
    pinned: true,
    salience: 5,
  });
  const unrelated = await injectedForPrompt(h, 'polish memory extension display');
  assert(!unrelated.includes('Global editor telemetry hook'), 'unrelated pinned user codebase notes should stay out of injection despite generic terms');
  const related = await injectedForPrompt(h, 'editor telemetry hook details');
  assert(related.includes('Global editor telemetry hook'), 'matching pinned user codebase notes should still be retrievable');
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
  const injected = await injectedForPrompt(h, 'validation commands npm test fixture smoke validate');
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
  const injected = await injectedForPrompt(h, 'configured preference lookup');
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

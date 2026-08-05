import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { configuredPackage, parsePiList } from './smoke-configured.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse JSON from ${path}`, { cause: error });
  }
}
const packageJson = readJson(join(root, 'package.json'));
const entry = packageJson.pi?.extensions?.[0];

assert.equal(entry, './extensions/hybrid-memory.ts', 'package should expose the stable Pi extension entrypoint');
assert(existsSync(join(root, entry)), 'Pi extension entrypoint should exist');
assert.match(packageJson.engines?.node ?? '', /^>=22\.19\.0$/, 'package should declare Pi-compatible Node support');
for (const dependency of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
  assert.equal(packageJson.peerDependencies?.[dependency], '*', `${dependency} should remain a Pi-provided wildcard peer`);
  assert(packageJson.devDependencies?.[dependency], `${dependency} should be pinned for reproducible development`);
}
assert.match(packageJson.scripts?.test ?? '', /typecheck/, 'the default test gate should include TypeScript validation');
assert.match(packageJson.scripts?.validate ?? '', /smoke:load.*smoke:configured/, 'validation should run isolated and configured Pi smoke tests in order');
const listedPackages = parsePiList('User packages:\n  git:github.com/feveromo/pi-hybrid-memory\n    /tmp/pi-hybrid-memory\n');
assert.equal(configuredPackage(listedPackages, 'pi-hybrid-memory', 'pi-hybrid-memory')?.path, '/tmp/pi-hybrid-memory', 'configured smoke should resolve the active package path from pi list');

const entrySource = readFileSync(join(root, entry), 'utf8');
assert.match(entrySource, /runtime\/registration\.ts/, 'the stable Pi entrypoint should stay thin');
assert(entrySource.split(/\n/).filter(Boolean).length <= 3, 'the stable Pi entrypoint should not become a monolith again');
const runtimeDir = join(root, 'extensions', 'runtime');
const runtimeFiles = readdirSync(runtimeDir).filter((file) => file.endsWith('.ts'));
for (const required of ['configuration.ts', 'retrieval.ts', 'memory-purge.ts', 'command-args.ts', 'audit-ui.ts']) {
  assert(runtimeFiles.includes(required), `${required} should keep its runtime responsibility isolated`);
}
const runtimeSources = runtimeFiles.map((file) => ({ file, text: readFileSync(join(runtimeDir, file), 'utf8') }));
for (const { file, text } of runtimeSources) {
  assert(text.split(/\n/).length <= 650, `${file} is becoming a god file; split it at a responsibility boundary`);
}
const runtimeSourceByFile = new Map(runtimeSources.map(({ file, text }) => [file, text]));
const runtimeDependencies = new Map(runtimeSources.map(({ file, text }) => [
  file,
  [...text.matchAll(/from\s+["'](\.\/[^"']+\.ts)["']/g)]
    .map((match) => match[1].slice(2))
    .filter((dependency) => runtimeSourceByFile.has(dependency)),
]));
const visitState = new Map();
const visitStack = [];
function assertAcyclicRuntime(file) {
  if (visitState.get(file) === 2) return;
  if (visitState.get(file) === 1) {
    const cycleStart = visitStack.indexOf(file);
    assert.fail(`runtime dependency cycle: ${[...visitStack.slice(cycleStart), file].join(' -> ')}`);
  }
  visitState.set(file, 1);
  visitStack.push(file);
  for (const dependency of runtimeDependencies.get(file) ?? []) assertAcyclicRuntime(dependency);
  visitStack.pop();
  visitState.set(file, 2);
}
for (const file of runtimeFiles) assertAcyclicRuntime(file);
const source = runtimeSources.map(({ text }) => text).join('\n');
assert.match(source, /from "@earendil-works\/pi-ai\/compat"/, 'legacy completion must use Pi’s explicit compatibility entrypoint');
assert.doesNotMatch(source, /import\s*\{[^}]*\bcomplete\b[^}]*\}\s*from\s*"@earendil-works\/pi-ai"/, 'deprecated root completion import must not return');
assert.doesNotMatch(source, /ctx\.ui\.notify\([^;]*,\s*"success"\s*\)/s, 'notification levels must stay within Pi’s public API');

const toolNames = [...source.matchAll(/name:\s*"(hybrid_memory_[^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(toolNames).size, 10, 'all ten public memory tools should remain registered exactly once');
assert(toolNames.includes('hybrid_memory_explain'), 'read-only retrieval explanation tool should be registered');
for (const command of ['hmemory', 'hmemory-health', 'hmemory-audit', 'hmemory-purge', 'hmemory-toggle']) {
  assert(source.includes(`registerCommand("${command}"`), `/${command} should remain registered`);
}

console.log('pi-hybrid-memory package/registration/architecture tests ok');

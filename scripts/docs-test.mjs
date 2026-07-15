import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const runtimeDir = join(root, 'extensions', 'runtime');
const commandSource = readFileSync(join(runtimeDir, 'register-commands.ts'), 'utf8');
const toolSource = readFileSync(join(runtimeDir, 'register-tools.ts'), 'utf8');
const reference = readFileSync(join(root, 'docs', 'reference.md'), 'utf8');

const commands = [...commandSource.matchAll(/registerCommand\("([^"]+)"/g)].map((match) => match[1]);
const tools = [...toolSource.matchAll(/name:\s*"(hybrid_memory_[^"]+)"/g)].map((match) => match[1]);
for (const command of commands) assert(reference.includes(`\`/${command}`), `docs/reference.md should inventory /${command}`);
for (const tool of tools) assert(reference.includes(`\`${tool}\``), `docs/reference.md should inventory ${tool}`);

const markdownFiles = [
  join(root, 'README.md'),
  join(root, 'CONTRIBUTING.md'),
  join(root, 'SECURITY.md'),
  ...readdirSync(join(root, 'docs')).filter((file) => file.endsWith('.md')).map((file) => join(root, 'docs', file)),
];
for (const file of markdownFiles) {
  const markdown = readFileSync(file, 'utf8');
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (!rawTarget || rawTarget.startsWith('#') || /^(?:https?:|mailto:)/i.test(rawTarget)) continue;
    const pathPart = rawTarget.split(/\s+/)[0].split(/[?#]/)[0];
    const target = resolve(dirname(file), decodeURIComponent(pathPart));
    assert(existsSync(target), `${file.slice(root.length + 1)} links to missing local target ${pathPart}`);
  }
}

console.log(`pi-hybrid-memory docs contracts ok (${markdownFiles.length} files, ${commands.length} commands, ${tools.length} tools)`);

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);

export function parsePiList(output) {
  const packages = [];
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const source = lines[index]?.match(/^ {2}(\S.*?)(?: \(filtered\))?$/)?.[1];
    const path = lines[index + 1]?.match(/^ {4}(\/.*)$/)?.[1];
    if (!source || !path) continue;
    packages.push({ source, path });
    index++;
  }
  return packages;
}

export function configuredPackage(packages, packageName, rootName) {
  return packages.find((entry) => entry.source.includes(packageName)
    || entry.source.includes(rootName)
    || basename(entry.path) === packageName
    || basename(entry.path) === rootName);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2_000_000,
    ...options,
  });
}

function gitHead(path) {
  const result = run('git', ['rev-parse', 'HEAD'], { cwd: path });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitDirty(path) {
  const result = run('git', ['status', '--porcelain'], { cwd: path });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function failResult(label, result) {
  if (result.error) throw result.error;
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  throw new Error(`${label} exited with ${result.status ?? result.signal ?? 'unknown status'}${detail ? `\n${detail}` : ''}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse JSON from ${path}`, { cause: error });
  }
}

export function configuredRuntimeInfo(root = repoRoot) {
  const manifest = readJson(join(root, 'package.json'));
  const packageName = typeof manifest.name === 'string' ? manifest.name : basename(root);
  const listed = run('pi', ['list'], { cwd: root, env: { ...process.env, PI_OFFLINE: '1', PI_TELEMETRY: '0' } });
  if (listed.status !== 0) failResult('pi list', listed);
  const configured = configuredPackage(parsePiList(listed.stdout), packageName, basename(root));
  if (!configured) throw new Error(`No active Pi package matches ${packageName}. Run PI_OFFLINE=1 pi list to inspect package resolution.`);
  if (!existsSync(configured.path)) throw new Error(`Configured Pi package path does not exist: ${configured.path}`);
  const activePath = realpathSync(configured.path);
  const workingPath = realpathSync(root);
  const workingHead = gitHead(workingPath);
  const activeHead = gitHead(activePath);
  const parity = activePath === workingPath
    ? 'working-tree'
    : workingHead && activeHead && workingHead === activeHead
      ? gitDirty(workingPath) ? 'same-commit-working-tree-dirty' : 'same-commit'
      : 'different-revision-or-source';
  return { packageName, source: configured.source, activePath, workingPath, workingHead, activeHead, parity };
}

export function smokeConfiguredRuntime(root = repoRoot) {
  const info = configuredRuntimeInfo(root);
  const tempRoot = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-configured-smoke-'));
  const home = join(tempRoot, 'home');
  const project = join(tempRoot, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"pi-hybrid-memory-configured-smoke"}\n', 'utf8');
  try {
    const result = run('pi', ['--no-session', '--no-extensions', '-e', info.activePath, '-p', '/hmemory-health'], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
        PI_SKIP_VERSION_CHECK: '1',
      },
    });
    if (result.status !== 0) failResult('configured Pi smoke-load', result);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return info;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const info = smokeConfiguredRuntime();
  console.log(`pi-hybrid-memory configured smoke ok (${info.source} -> ${info.activePath})`);
  if (info.parity === 'same-commit-working-tree-dirty') {
    console.warn('parity warning: active Pi uses the same commit from its installed clone, but it does not include uncommitted working-tree changes.');
  } else if (info.parity === 'different-revision-or-source') {
    console.warn(`parity warning: active Pi revision ${info.activeHead?.slice(0, 8) ?? 'unknown'} differs from working revision ${info.workingHead?.slice(0, 8) ?? 'unknown'}.`);
  }
}

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const tempRoot = mkdtempSync(join(tmpdir(), 'pi-hybrid-memory-smoke-'));
const home = join(tempRoot, 'home');
const project = join(tempRoot, 'project');
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'package.json'), '{"name":"pi-hybrid-memory-smoke"}\n', 'utf8');

try {
  const result = spawnSync('pi', ['--no-session', '--no-extensions', '-e', repoRoot, '-p', '/hmemory-health'], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pi smoke-load exited with ${result.status ?? result.signal ?? 'unknown status'}`);
  console.log('pi-hybrid-memory isolated Pi smoke-load ok');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

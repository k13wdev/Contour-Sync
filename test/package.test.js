import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runNpm } from '../scripts/npm.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

test('tarball installs globally offline with an empty cache and runs outside the source tree', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'contour-sync-package-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const cache = path.join(temporary, 'empty-npm-cache');
  const prefix = path.join(temporary, 'prefix');
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  const isolated = [
    '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache,
    '--userconfig', os.devNull, '--globalconfig', os.devNull,
    '--registry', 'http://127.0.0.1:9',
  ];
  const [packed] = JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporary, ...isolated], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  }));
  assert.deepEqual(packed.files.map((file) => file.path).sort(), [
    'README.md', 'bin/csync.js', 'config/contour-sync.example.json',
    'lib/config.js', 'lib/files.js', 'lib/git.js', 'lib/sync.js', 'package.json',
  ].sort());
  assert.equal(Object.keys(metadata.dependencies || {}).length, 0);
  assert.equal(Object.keys(metadata.devDependencies || {}).length, 0);
  runNpm(['install', '--global', '--prefix', prefix, path.join(temporary, packed.filename), ...isolated], {
    cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  });
  const installed = process.platform === 'win32'
    ? path.join(prefix, 'node_modules/contour-sync')
    : path.join(prefix, 'lib/node_modules/contour-sync');
  const shim = process.platform === 'win32' ? path.join(prefix, 'csync.cmd') : path.join(prefix, 'bin/csync');
  await access(shim);
  const env = {
    ...process.env, CONTOUR_SYNC_CONFIG: '', CONTOUR_SYNC_TMP_DIR: temporary,
    XDG_CONFIG_HOME: path.join(temporary, 'xdg-config'), APPDATA: path.join(temporary, 'appdata'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  };
  const config = process.platform === 'win32'
    ? path.join(env.APPDATA, 'ContourSync/config.json')
    : path.join(env.XDG_CONFIG_HOME, 'contour-sync/config.json');
  const run = (...args) => process.platform === 'win32'
    ? execFileSync(process.execPath, [path.join(installed, 'bin/csync.js'), ...args], { cwd: workspace, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync(shim, args, { cwd: workspace, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(run('--version').trim(), metadata.version);
  assert.match(run('--help'), /Запуск: csync/);
  run('init'); // Verifies the example JSON is present in the installed package.
  const settings = JSON.parse(await readFile(config, 'utf8'));
  assert.ok(settings.projects.frontend);
  const git = (...args) => execFileSync('git', args, { cwd: workspace, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const target = path.join(workspace, 'target');
  const source = path.join(workspace, 'source');
  await mkdir(target); await mkdir(source);
  git('init', '-b', 'internal', target);
  await writeFile(path.join(target, 'app.txt'), 'old');
  git('-C', target, 'add', '.');
  git('-C', target, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
  await writeFile(path.join(source, 'app.txt'), 'new');
  await writeFile(config, JSON.stringify({ projects: { app: { targetDir: target } }, tempDir: temporary }));
  assert.equal(JSON.parse(run('doctor', '--json')).ok, true);
  const applied = JSON.parse(run('sync', '--from', source, '--yes', '--json'));
  assert.equal(await readFile(path.join(target, 'app.txt'), 'utf8'), 'new');
  run('restore', '--backup', applied.backup);
  assert.equal(await readFile(path.join(target, 'app.txt'), 'utf8'), 'old');
  assert.equal(git('-C', target, 'status', '--porcelain').trim(), '');
});

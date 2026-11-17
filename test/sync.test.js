import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadConfig, DEFAULT_PRESERVE } from '../lib/config.js';
import { createPlan, applyPlan, restoreBackup, patchRegistry } from '../lib/sync.js';
import { chooseBranches } from '../lib/branches.js';
import { inventory, sameInventory } from '../lib/files.js';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cli = fileURLToPath(new URL('../bin/csync.js', import.meta.url));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' };
function git(cwd, ...args) { return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function put(root, name, text) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
async function commit(root) { git(root, 'add', '.'); git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'); }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'contour-sync-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const source = path.join(root, 'source');
  await mkdir(target); await mkdir(source);
  git(target, 'init', '-b', 'internal');
  await put(target, '.gitignore', '.env\nnode_modules/\ncache/\n');
  await put(target, 'app.txt', 'old\n');
  await put(target, 'obsolete.txt', 'remove me\n');
  await commit(target);
  await put(source, '.gitignore', '.env\nnode_modules/\ncache/\n');
  await put(source, 'app.txt', 'new\n');
  await put(source, 'nested/new.txt', 'added\n');
  const repo = { name: 'test', targetDir: target, repoUrl: source, preserve: [...DEFAULT_PRESERVE] };
  const settings = { projects: [repo] };
  const plan = (options = {}) => createPlan(settings, repo, { from: source, target: 'internal', 'temp-dir': root, ...options });
  return { root, target, source, repo, settings, plan };
}

// Integration tests use real local Git repositories; no network or npm installation.
test('plan leaves target unchanged; apply and restore round trip additions, deletions and changes', async (t) => {
  const f = await fixture(t);
  const before = await inventory(f.target, DEFAULT_PRESERVE);
  const planned = await f.plan();
  assert.ok(sameInventory(before.entries, (await inventory(f.target, DEFAULT_PRESERVE)).entries));
  const result = await applyPlan(planned.filename);
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'new\n');
  await assert.rejects(readFile(path.join(f.target, 'obsolete.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.target, 'nested/new.txt'), 'utf8'), 'added\n');
  await restoreBackup(result.backup);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
  assert.ok(sameInventory(before.entries, (await inventory(f.target, DEFAULT_PRESERVE)).entries));
  await assert.rejects(restoreBackup(result.backup), /уже восстановлена/);
});

test('preserved and gitignored files cannot be deleted or overwritten', async (t) => {
  const f = await fixture(t);
  f.repo.preserve.push('nested/local.json', '.npmrc');
  await put(f.target, 'nested/local.json', 'internal');
  await put(f.target, '.npmrc', 'internal registry');
  await commit(f.target);
  await put(f.target, '.env', 'secret');
  await put(f.target, 'cache/data', 'cache');
  await put(f.source, 'nested/local.json', 'external');
  await put(f.source, '.npmrc', 'external registry');
  await put(f.source, '.env', 'external secret');
  await put(f.source, 'cache/data', 'external cache');
  const result = await applyPlan((await f.plan()).filename);
  assert.equal(await readFile(path.join(f.target, 'nested/local.json'), 'utf8'), 'internal');
  assert.equal(await readFile(path.join(f.target, '.npmrc'), 'utf8'), 'internal registry');
  assert.equal(await readFile(path.join(f.target, '.env'), 'utf8'), 'secret');
  assert.equal(await readFile(path.join(f.target, 'cache/data'), 'utf8'), 'cache');
  await restoreBackup(result.backup);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('missing source parent does not delete a protected nested file', async (t) => {
  const f = await fixture(t);
  f.repo.preserve.push('private/keep.txt');
  await put(f.target, 'private/keep.txt', 'keep');
  await put(f.target, 'private/remove.txt', 'remove');
  await commit(f.target);
  const applied = await applyPlan((await f.plan()).filename);
  assert.equal(await readFile(path.join(f.target, 'private/keep.txt'), 'utf8'), 'keep');
  await assert.rejects(readFile(path.join(f.target, 'private/remove.txt')), { code: 'ENOENT' });
  await restoreBackup(applied.backup);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('replacing a directory containing a preserved file is refused', async (t) => {
  const f = await fixture(t);
  f.repo.preserve.push('protected/keep');
  await put(f.target, 'protected/keep', 'keep'); await commit(f.target);
  await put(f.source, 'protected', 'file');
  await assert.rejects(f.plan(), /защищённые/);
  assert.equal(await readFile(path.join(f.target, 'protected/keep'), 'utf8'), 'keep');
});

test('dirty target and nonexistent target branch are refused before planning', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.plan({ target: 'main' }), /не существует/);
  await put(f.target, 'untracked', 'local');
  await assert.rejects(f.plan(), /незакоммиченные/);
  assert.equal((await readdir(f.root)).filter((name) => name.startsWith('contour-sync-')).length, 0);
});

test('apply refuses changed files, branch and HEAD after planning', async (t) => {
  const f = await fixture(t);
  const p = await f.plan();
  await put(f.target, 'app.txt', 'local edit');
  await assert.rejects(applyPlan(p.filename), /незакоммиченные/);
  git(f.target, 'restore', 'app.txt');
  git(f.target, 'switch', '-c', 'another');
  await assert.rejects(applyPlan(p.filename), /Ожидалась ветка/);
  git(f.target, 'switch', 'internal');
  git(f.target, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'new head');
  await assert.rejects(applyPlan(p.filename), /HEAD изменился/);
});

test('apply refuses a modified snapshot', async (t) => {
  const f = await fixture(t); const p = await f.plan();
  await put(path.dirname(p.filename), 'snapshot/app.txt', 'tampered');
  await assert.rejects(applyPlan(p.filename), /Снимок изменён/);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('restore does not overwrite subsequent edits', async (t) => {
  const f = await fixture(t); const applied = await applyPlan((await f.plan()).filename);
  await put(f.target, 'app.txt', 'my work');
  await assert.rejects(restoreBackup(applied.backup), /были внесены изменения/);
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'my work');
});

test('file-directory transitions round trip', async (t) => {
  const f = await fixture(t);
  await put(f.target, 'file-to-dir', 'before');
  await put(f.target, 'dir-to-file/child', 'before'); await commit(f.target);
  await put(f.source, 'file-to-dir/child', 'after');
  await put(f.source, 'dir-to-file', 'after');
  const applied = await applyPlan((await f.plan()).filename);
  assert.equal(await readFile(path.join(f.target, 'file-to-dir/child'), 'utf8'), 'after');
  assert.equal(await readFile(path.join(f.target, 'dir-to-file'), 'utf8'), 'after');
  await restoreBackup(applied.backup);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('symlinks and empty sources are refused without changing target', async (t) => {
  const f = await fixture(t);
  await symlink('../target/app.txt', path.join(f.source, 'link'));
  await assert.rejects(f.plan(), /Символические ссылки/);
  await rm(path.join(f.source, 'link'));
  const empty = path.join(f.root, 'empty'); await mkdir(empty);
  await assert.rejects(f.plan({ from: empty }), /не содержит файлов/);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('overlapping sources and output directories are refused', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.plan({ from: f.root }), /не должны пересекаться/);
  await assert.rejects(f.plan({ output: path.join(f.target, 'plan') }), /вне источника/);
  await assert.rejects(f.plan({ output: path.join(f.source, 'plan') }), /вне источника/);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('registry transformation changes only matching resolved URLs and preserves integrity', async (t) => {
  const f = await fixture(t);
  const lock = { lockfileVersion: 3, note: 'https://registry.npmjs.org/a', packages: {
    'node_modules/a': { resolved: 'https://registry.npmjs.org/a/-/a.tgz', integrity: 'sha512-original' },
    'node_modules/b': { resolved: 'https://registry.npmjs.org.evil/a.tgz' },
  } };
  await put(f.source, 'package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  f.repo.nexus = { externalRegistryUrls: ['https://registry.npmjs.org/'], internalNexusUrl: 'https://nexus.example/npm/' };
  const p = await f.plan();
  assert.equal(p.plan.registryChanges, 1);
  const result = JSON.parse(await readFile(path.join(path.dirname(p.filename), 'snapshot/package-lock.json')));
  assert.equal(result.packages['node_modules/a'].resolved, 'https://nexus.example/npm/a/-/a.tgz');
  assert.equal(result.packages['node_modules/a'].integrity, 'sha512-original');
  assert.equal(result.packages['node_modules/b'].resolved, lock.packages['node_modules/b'].resolved);
  assert.equal(result.note, lock.note);
  assert.equal(await patchRegistry(path.join(path.dirname(p.filename), 'snapshot'), f.repo.nexus), 0);
});

test('Git clone uses local source branch and records its exact commit', async (t) => {
  const f = await fixture(t);
  git(f.source, 'init', '-b', 'main'); await commit(f.source);
  const p = await createPlan(f.settings, f.repo, { source: 'main', target: 'internal', 'temp-dir': f.root });
  assert.equal(p.plan.origin.commit, git(f.source, 'rev-parse', 'HEAD'));
  assert.equal(p.plan.origin.branch, 'main');
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('interrupted application can be restored from a prepared backup', async (t) => {
  const f = await fixture(t); const result = await applyPlan((await f.plan()).filename);
  const backup = JSON.parse(await readFile(result.backup));
  backup.state = 'prepared'; await writeFile(result.backup, JSON.stringify(backup));
  await rm(path.join(f.target, 'app.txt')); // Simulate interruption between deletion and replacement.
  await restoreBackup(result.backup);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('repository lock prevents concurrent writes', async (t) => {
  const f = await fixture(t); const p = await f.plan();
  await put(f.target, '.git/contour-sync.lock', 'another process');
  await assert.rejects(applyPlan(p.filename), /Репозиторий занят/);
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'old\n');
});

test('tampered plan cannot access traversal or .git paths', async (t) => {
  const f = await fixture(t); const p = await f.plan();
  for (const name of ['../escape', '.git/config', 'nested/.GIT/config']) {
    const plan = JSON.parse(await readFile(p.filename));
    plan.after[name] = { type: 'file', hash: 'a'.repeat(64), executable: false };
    const bad = path.join(path.dirname(p.filename), 'bad.json'); await writeFile(bad, JSON.stringify(plan));
    await assert.rejects(applyPlan(bad), /Недопустимый|защищённый/);
  }
});

test('executable bits survive transfer and restore', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t); await put(f.source, 'script.sh', '#!/bin/sh\nexit 0\n');
  await chmod(path.join(f.source, 'script.sh'), 0o755);
  const result = await applyPlan((await f.plan()).filename);
  assert.ok((await stat(path.join(f.target, 'script.sh'))).mode & 0o111);
  await restoreBackup(result.backup);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('JSON config validates unknown fields and resolves relative paths against config', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'contour-sync.json');
  await writeFile(filename, JSON.stringify({ projects: { app: { targetDir: './target', preserve: ['nested/keep'] } } }));
  const settings = await loadConfig(filename);
  assert.equal(settings.projects[0].targetDir, f.target);
  assert.ok(settings.projects[0].preserve.includes('nested/keep'));
  await writeFile(filename, JSON.stringify({ projects: { app: { targetDir: f.target, presreve: [] } } }));
  await assert.rejects(loadConfig(filename), /неизвестное поле presreve/);
});

test('CLI init, help and strict arguments work without dependencies', async (t) => {
  const f = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: f.root, env: { ...env, CONTOUR_SYNC_CONFIG: path.join(f.root, 'contour-sync.json') }, encoding: 'utf8' });
  assert.equal(run('--help').status, 0);
  assert.equal(run('--version').stdout.trim(), version);
  assert.equal(run('init').status, 0);
  assert.equal(run('init').status, 1); // Never overwrite settings.
  assert.equal(run('plan', '--typo').status, 1);
  assert.equal(run('apply', '--yes').status, 1);
  assert.equal(run('sync', '--dry-run', '--yes').status, 1);
});

test('CLI JSON sync emits one document and works from a read-only working directory', async (t) => {
  const f = await fixture(t);
  const config = path.join(f.root, 'contour-sync.json');
  await writeFile(config, JSON.stringify({ projects: { app: { targetDir: f.target } }, tempDir: f.root }));
  const readonly = path.join(f.root, 'readonly'); await mkdir(readonly); await chmod(readonly, 0o555);
  t.after(() => chmod(readonly, 0o755).catch(() => {}));
  const result = spawnSync(process.execPath, [cli, 'sync', '--config', config, '--from', f.source, '--target', 'internal', '--yes', '--json'], { cwd: readonly, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.backup);
  assert.ok(output.operations.length);
  await restoreBackup(output.backup);
});

test('cancellation after backup automatically restores the original tree', async (t) => {
  const f = await fixture(t); const p = await f.plan();
  const cancellation = new AbortController(); cancellation.abort(new Error('test cancellation'));
  await assert.rejects(applyPlan(p.filename, { signal: cancellation.signal }), /Изменения отменены/);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'old\n');
});

test('diff shows actual content changes without modifying target', async (t) => {
  const f = await fixture(t); const p = await f.plan();
  const { diffPlan } = await import('../lib/sync.js');
  const output = await diffPlan(p.filename);
  assert.match(output, /-old/); assert.match(output, /\+new/);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
  assert.equal((await readdir(path.dirname(p.filename))).filter((name) => name.startsWith('diff-')).length, 0);
});

test('missing or read-only temporary root yields a useful error without touching target', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.plan({ 'temp-dir': path.join(f.root, 'missing') }), /CONTOUR_SYNC_TMP_DIR/);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const readonly = path.join(f.root, 'readonly-temp'); await mkdir(readonly); await chmod(readonly, 0o555);
    try { await assert.rejects(f.plan({ 'temp-dir': readonly }), /недоступен для записи/); }
    finally { await chmod(readonly, 0o755); }
  }
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('Git hidden working-tree flags are refused', async (t) => {
  const f = await fixture(t);
  git(f.target, 'update-index', '--assume-unchanged', 'app.txt');
  await put(f.target, 'app.txt', 'hidden edit');
  await assert.rejects(f.plan(), /skip-worktree\/assume-unchanged/);
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'hidden edit');
});

test('special file names are handled as data, including prototype property names', async (t) => {
  const f = await fixture(t);
  await put(f.source, '__proto__', 'data');
  await put(f.source, 'constructor', 'data');
  await put(f.source, 'with spaces.txt', 'data');
  const result = await applyPlan((await f.plan()).filename);
  assert.equal(await readFile(path.join(f.target, '__proto__'), 'utf8'), 'data');
  await restoreBackup(result.backup);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('CLI doctor and projects emit valid JSON', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'contour-sync.json');
  await writeFile(filename, JSON.stringify({ projects: { app: { targetDir: './target' } }, tempDir: f.root }));
  const run = (command) => spawnSync(process.execPath, [cli, command, '--config', filename, '--json'], { cwd: f.root, env, encoding: 'utf8' });
  const doctor = run('doctor'); assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
  assert.equal(JSON.parse(run('projects').stdout)[0].name, 'app');
});

test('an error after partial writes triggers complete automatic recovery', async (t) => {
  const f = await fixture(t); const p = await f.plan();
  let checkpoints = 0;
  const signal = { throwIfAborted() { if (++checkpoints === 4) throw new Error('simulated I/O interruption'); } };
  await assert.rejects(applyPlan(p.filename, { signal }), /Изменения отменены/);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
  assert.equal(await readFile(path.join(f.target, 'obsolete.txt'), 'utf8'), 'remove me\n');
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'old\n');
});

test('an identical source creates a no-op plan with no backup', async (t) => {
  const f = await fixture(t);
  const { copyEntries } = await import('../lib/files.js');
  await rm(f.source, { recursive: true });
  const files = await inventory(f.target, DEFAULT_PRESERVE);
  await copyEntries(f.target, f.source, files.entries);
  const p = await f.plan(); assert.equal(p.operations.length, 0);
  const result = await applyPlan(p.filename);
  assert.equal(result.backup, null);
  assert.equal(git(f.target, 'status', '--porcelain'), '');
});

test('restore refuses newly staged changes', async (t) => {
  const f = await fixture(t); const result = await applyPlan((await f.plan()).filename);
  git(f.target, 'add', '.');
  await assert.rejects(restoreBackup(result.backup), /Git-индексе/);
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'new\n');
});

test('inherited Git environment cannot redirect the selected repository', async (t) => {
  const f = await fixture(t);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(f.root, 'nonexistent.git');
  try {
    const p = await f.plan();
    assert.equal(p.plan.target, await (await import('node:fs/promises')).realpath(f.target));
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

test('planning switches to an existing target branch and uses its files and HEAD', async (t) => {
  const f = await fixture(t);
  git(f.target, 'switch', '-c', 'destination');
  await put(f.target, 'app.txt', 'destination version\n'); await commit(f.target);
  const head = git(f.target, 'rev-parse', 'HEAD');
  const before = await inventory(f.target, DEFAULT_PRESERVE);
  git(f.target, 'switch', 'internal');
  const p = await f.plan({ target: 'destination' });
  assert.equal(git(f.target, 'branch', '--show-current'), 'destination');
  assert.equal(git(f.target, 'status', '--porcelain'), '');
  assert.equal(p.plan.head, head);
  assert.ok(sameInventory(p.plan.before, before.entries));
  const result = await applyPlan(p.filename);
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'new\n');
  await restoreBackup(result.backup);
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'destination version\n');
});

test('dirty current branch is never switched or stashed automatically', async (t) => {
  const f = await fixture(t); git(f.target, 'branch', 'destination');
  await put(f.target, 'app.txt', 'my unfinished work');
  await assert.rejects(f.plan({ target: 'destination' }), /незакоммиченные/);
  assert.equal(git(f.target, 'branch', '--show-current'), 'internal');
  assert.equal(await readFile(path.join(f.target, 'app.txt'), 'utf8'), 'my unfinished work');
});

test('failed planning after switching returns to the original branch', async (t) => {
  const f = await fixture(t); git(f.target, 'branch', 'destination');
  f.repo.nexus = { externalRegistryUrls: ['https://registry.npmjs.org'], internalNexusUrl: 'https://nexus.example/npm' };
  await put(f.source, 'package-lock.json', 'invalid JSON');
  await assert.rejects(f.plan({ target: 'destination' }), /JSON/);
  assert.equal(git(f.target, 'branch', '--show-current'), 'internal');
  assert.equal(git(f.target, 'status', '--porcelain'), '');
  assert.equal((await readdir(f.root)).filter((name) => name.startsWith('contour-sync-')).length, 0);
});

test('failed cloning leaves the original branch selected', async (t) => {
  const f = await fixture(t); git(f.target, 'branch', 'destination');
  await assert.rejects(createPlan(f.settings, f.repo, { source: 'missing', target: 'destination', 'temp-dir': f.root }), /Git:/);
  assert.equal(git(f.target, 'branch', '--show-current'), 'internal');
});

test('remote-only destination is not guessed or created as a local branch', async (t) => {
  const f = await fixture(t);
  git(f.target, 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD');
  await assert.rejects(f.plan({ target: 'remote-only' }), /не существует/);
  assert.equal(git(f.target, 'branch', '--show-current'), 'internal');
});

test('branch switching does not overwrite ignored local files', async (t) => {
  const f = await fixture(t);
  git(f.target, 'switch', '-c', 'destination');
  await put(f.target, '.env', 'tracked destination value');
  git(f.target, 'add', '-f', '.env'); await commit(f.target);
  git(f.target, 'switch', 'internal');
  await put(f.target, '.env', 'local secret');
  await assert.rejects(f.plan({ target: 'destination' }), /Git:/);
  assert.equal(git(f.target, 'branch', '--show-current'), 'internal');
  assert.equal(await readFile(path.join(f.target, '.env'), 'utf8'), 'local secret');
});

test('source and target must be explicit; there is no main fallback', async (t) => {
  const f = await fixture(t);
  await assert.rejects(createPlan(f.settings, f.repo, { target: 'internal' }), /--source/);
  await assert.rejects(createPlan(f.settings, f.repo, { source: 'main' }), /--target/);
  await assert.rejects(createPlan(f.settings, f.repo, { from: f.source }), /--target/);
  const filename = path.join(f.root, 'config.json');
  await writeFile(filename, JSON.stringify({ projects: { app: { targetDir: f.target, sourceBranch: 'main' } } }));
  await assert.rejects(loadConfig(filename), /удалите sourceBranch/);
});

test('interactive selection asks for source and local destination, retrying invalid input', async (t) => {
  const f = await fixture(t); git(f.target, 'branch', 'destination');
  const answers = ['', 'bad branch', 'release/1.2', 'unknown', 'destination'];
  const questions = []; const messages = [];
  const result = await chooseBranches(f.repo, {}, {
    interactive: true, ask: async (message) => { questions.push(message); return answers.shift(); },
    print: (message) => messages.push(message),
  });
  assert.equal(result.source, 'release/1.2');
  assert.equal(result.target, 'destination');
  assert.equal(questions.length, 5);
  assert.ok(messages.some((message) => message.includes('destination')));
  assert.equal(git(f.target, 'branch', '--show-current'), 'internal');
});

test('local snapshot skips the source-branch question and allows target selection by number', async (t) => {
  const f = await fixture(t); const questions = [];
  const result = await chooseBranches(f.repo, { from: f.source }, {
    interactive: true, ask: async (message) => { questions.push(message); return '1'; }, print: () => {},
  });
  assert.equal(result.source, undefined);
  assert.equal(result.target, 'internal');
  assert.equal(questions.length, 1);
});

test('noninteractive selection requires flags and never asks questions', async (t) => {
  const f = await fixture(t);
  const ui = { interactive: false, ask: () => assert.fail('unexpected question'), print: () => assert.fail('unexpected output') };
  await assert.rejects(chooseBranches(f.repo, {}, ui), /--source/);
  await assert.rejects(chooseBranches(f.repo, { source: 'develop' }, ui), /--target/);
  assert.deepEqual(await chooseBranches(f.repo, { source: 'develop', target: 'internal' }, ui), { source: 'develop', target: 'internal' });
});

test('CLI rejects missing branches before creating a plan or switching the destination', async (t) => {
  const f = await fixture(t); const filename = path.join(f.root, 'config.json');
  await writeFile(filename, JSON.stringify({ projects: { app: { targetDir: f.target, repo: f.source } }, tempDir: f.root }));
  const run = (...args) => spawnSync(process.execPath, [cli, 'plan', '--config', filename, '--json', ...args], { env, encoding: 'utf8' });
  const missingSource = run('--target', 'internal');
  assert.equal(missingSource.status, 1); assert.match(JSON.parse(missingSource.stderr).error, /--source/);
  const missingTarget = run('--from', f.source);
  assert.equal(missingTarget.status, 1); assert.match(JSON.parse(missingTarget.stderr).error, /--target/);
  assert.equal(git(f.target, 'branch', '--show-current'), 'internal');
});

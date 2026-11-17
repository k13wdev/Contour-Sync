import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, lstat, open, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PRESERVE, inside, isPreserved, relativeName, rejectOverlap } from './config.js';
import { git, inspectTarget, validateBranch, requireLocalBranch, switchBranch } from './git.js';
import { inventory, sameInventory, sameEntry, changes, copyEntries, assertWritable, executeChanges } from './files.js';

export async function writeJson(filename, value) {
  const staging = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(staging, filename);
  } finally { await rm(staging, { force: true }); }
}

export async function temporaryRoot(tempDir) {
  let root = path.resolve(tempDir || process.env.CONTOUR_SYNC_TMP_DIR || os.tmpdir());
  try {
    root = await realpath(root);
    const probe = await mkdtemp(path.join(root, 'contour-sync-check-'));
    await rm(probe, { recursive: true });
  } catch (error) {
    throw new Error(`Временный каталог недоступен для записи: ${root} (${error.code}). Задайте CONTOUR_SYNC_TMP_DIR или --temp-dir.`);
  }
  return root;
}

export async function patchRegistry(snapshot, nexus) {
  if (!nexus) return 0;
  const filename = path.join(snapshot, 'package-lock.json');
  let raw;
  try { raw = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const lock = JSON.parse(raw);
  let count = 0;
  const external = nexus.externalRegistryUrls.map((url) => url.replace(/\/+$/, '')).sort((a, b) => b.length - a.length);
  const internal = nexus.internalNexusUrl.replace(/\/+$/, '');
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'resolved' && typeof child === 'string') {
        const prefix = external.find((url) => child.startsWith(`${url}/`));
        if (prefix && !child.startsWith(`${internal}/`)) {
          value[key] = internal + child.slice(prefix.length);
          count++;
        }
      } else visit(child);
    }
  }
  visit(lock);
  if (count) {
    const indent = raw.match(/\n([\t ]+)"/)?.[1] || '  ';
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const serialized = JSON.stringify(lock, null, indent).replace(/\n/g, newline);
    await writeFile(filename, serialized + (raw.endsWith('\n') ? newline : ''));
  }
  return count;
}

async function newPlanDirectory(output, tempDir, target, source) {
  const parent = await realpath(output ? path.dirname(path.resolve(output)) : await temporaryRoot(tempDir));
  const candidate = output ? path.join(parent, path.basename(output)) : path.join(parent, `contour-sync-${randomUUID()}`);
  for (const root of [target, source].filter(Boolean)) {
    const canonical = await realpath(root);
    if (inside(canonical, candidate) || inside(candidate, canonical)) throw new Error('Папка плана должна быть вне источника и целевого репозитория');
  }
  await mkdir(candidate, { mode: 0o700 });
  return candidate;
}

export async function createPlan(settings, repo, options = {}) {
  if (!options.target) throw new Error('Укажите целевую локальную ветку через --target');
  if (options.from && options.source) throw new Error('Используйте только один источник: --from или --source');
  if (!options.from) {
    if (!options.source) throw new Error('Укажите исходную ветку через --source');
    validateBranch(options.source);
    if (!repo.repoUrl) throw new Error('Для проекта не задан repo. Укажите --from или добавьте repo в настройки.');
  }
  const state = await inspectTarget(repo.targetDir);
  return lockTarget(state.target, () => createPlanLocked(settings, repo, options));
}

async function createPlanLocked(settings, repo, options) {
  const initial = await inspectTarget(repo.targetDir);
  requireLocalBranch(initial.target, options.target);
  const targetHead = git(['rev-parse', `refs/heads/${options.target}`], initial.target);
  await assertWritable(initial.target, []);
  if (options.from) await rejectOverlap(options.from, initial.target);
  const directory = await newPlanDirectory(options.output, options['temp-dir'] || process.env.CONTOUR_SYNC_TMP_DIR || settings.tempDir, initial.target, options.from);
  let switchAttempted = false;
  try {
    let source;
    let origin;
    if (options.from) {
      source = await realpath(options.from);
      origin = { directory: source };
    } else {
      source = path.join(directory, 'clone');
      git(['clone', '--depth', '1', '--single-branch', '--branch', options.source, '--', repo.repoUrl, source]);
      // Submodules must be transferred explicitly, otherwise their contents would disappear silently.
      if (git(['ls-files', '--stage'], source).split('\n').some((line) => line.startsWith('160000 '))) {
        throw new Error('Источник содержит Git submodules. Подготовьте полный снимок и используйте --from.');
      }
      origin = { repository: repo.repoUrl, branch: options.source, commit: git(['rev-parse', 'HEAD'], source) };
    }
    options.signal?.throwIfAborted();
    const latest = await inspectTarget(initial.target, initial.branch);
    if (latest.head !== initial.head || git(['rev-parse', `refs/heads/${options.target}`], initial.target) !== targetHead) {
      throw new Error('Ветки изменились во время подготовки источника. Повторите запуск.');
    }
    if (initial.branch !== options.target) {
      switchAttempted = true;
      switchBranch(initial.target, options.target);
    }
    const state = await inspectTarget(initial.target, options.target);
    const preserve = [...new Set([...DEFAULT_PRESERVE, ...repo.preserve, ...state.ignored])];
    options.signal?.throwIfAborted();
    preserve.forEach(relativeName);
    const before = await inventory(state.target, preserve);
    const incoming = await inventory(source, preserve);
    if (!Object.values(incoming.entries).some((entry) => entry.type === 'file')) {
      throw new Error('Источник не содержит файлов для переноса. Пустой снимок не применяется.');
    }
    const snapshot = path.join(directory, 'snapshot');
    await copyEntries(source, snapshot, incoming.entries);
    const registryChanges = await patchRegistry(snapshot, repo.nexus);
    const after = await inventory(snapshot, preserve);
    const operations = changes(before.entries, after.entries, before.protectedPaths);
    await assertWritable(state.target, operations);
    const plan = {
      version: 1, kind: 'contour-sync-plan', createdAt: new Date().toISOString(), project: repo.name,
      target: state.target, branch: state.branch, head: state.head, origin, preserve,
      before: before.entries, after: after.entries, protectedPaths: before.protectedPaths, registryChanges,
    };
    await writeJson(path.join(directory, 'plan.json'), plan);
    await rm(path.join(directory, 'clone'), { recursive: true, force: true });
    return { plan, operations, filename: path.join(directory, 'plan.json') };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (switchAttempted) {
      try {
        const current = git(['branch', '--show-current'], initial.target);
        if (current !== initial.branch) {
          if (current !== options.target || git(['status', '--porcelain=v1', '--untracked-files=all'], initial.target) ||
              git(['rev-parse', 'HEAD'], initial.target) !== targetHead ||
              git(['rev-parse', `refs/heads/${initial.branch}`], initial.target) !== initial.head) {
            throw new Error('состояние репозитория изменилось');
          }
          switchBranch(initial.target, initial.branch);
        }
      } catch (restoreError) {
        throw new Error(`${error.message}. Не удалось вернуть ветку "${initial.branch}": ${restoreError.message}. Проверьте git status.`);
      }
    }
    throw error;
  }
}

function validateEntries(entries, preserve) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Повреждён список файлов в плане');
  for (const [name, entry] of Object.entries(entries)) {
    relativeName(name);
    if (isPreserved(name, preserve)) throw new Error(`План затрагивает защищённый путь: ${name}`);
    if (!entry || !['file', 'directory'].includes(entry.type) ||
        (entry.type === 'file' && (!/^[a-f0-9]{64}$/.test(entry.hash) || typeof entry.executable !== 'boolean'))) {
      throw new Error(`Повреждена запись плана: ${name}`);
    }
    const parent = path.posix.dirname(name);
    if (parent !== '.' && (!Object.hasOwn(entries, parent) || entries[parent].type !== 'directory')) {
      throw new Error(`В плане отсутствует родительский каталог: ${name}`);
    }
  }
}

async function readManifest(filename, kind) {
  const actual = await realpath(filename);
  const manifest = JSON.parse(await readFile(actual, 'utf8'));
  if (manifest.version !== 1 || manifest.kind !== kind || typeof manifest.target !== 'string' ||
      !path.isAbsolute(manifest.target) || typeof manifest.branch !== 'string' || !manifest.branch ||
      !/^[a-f0-9]{40,64}$/.test(manifest.head) || !Array.isArray(manifest.preserve) || !Array.isArray(manifest.protectedPaths)) {
    throw new Error('Неподдерживаемый или повреждённый файл плана/резервной копии');
  }
  manifest.preserve.forEach(relativeName);
  manifest.protectedPaths.forEach(relativeName);
  // Mandatory protections apply even when a manifest has been edited.
  const preserve = [...DEFAULT_PRESERVE, ...manifest.preserve];
  validateEntries(manifest.before, preserve);
  validateEntries(manifest.after, preserve);
  const directory = path.dirname(actual);
  await rejectOverlap(directory, manifest.target);
  return { manifest: { ...manifest, preserve, before: Object.assign(Object.create(null), manifest.before), after: Object.assign(Object.create(null), manifest.after) }, directory, filename: actual };
}

async function lockTarget(target, action) {
  const lockname = path.resolve(target, git(['rev-parse', '--git-path', 'contour-sync.lock'], target));
  let handle;
  try { handle = await open(lockname, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Репозиторий занят contour-sync. Если предыдущий процесс аварийно завершился, проверьте и удалите ${lockname}`);
    throw error;
  }
  try { await handle.writeFile(`${process.pid}\n`); return await action(); }
  finally { await handle.close(); await rm(lockname, { force: true }); }
}

function expectedAfter(plan, operations) {
  const entries = Object.assign(Object.create(null), plan.before);
  for (const op of operations) {
    if (op.after) entries[op.path] = op.after;
    else delete entries[op.path];
  }
  return entries;
}

async function assertSnapshot(directory, expected, preserve) {
  const snapshot = path.join(directory, 'snapshot');
  if ((await lstat(snapshot)).isSymbolicLink()) throw new Error('Каталог снимка не должен быть символической ссылкой');
  const actual = await inventory(snapshot, preserve);
  if (!sameInventory(actual.entries, expected)) throw new Error('Снимок изменён или повреждён. Создайте новый план.');
  return snapshot;
}

export async function applyPlan(filename, { signal } = {}) {
  const { manifest: plan, directory } = await readManifest(filename, 'contour-sync-plan');
  return lockTarget(plan.target, async () => {
    const state = await inspectTarget(plan.target, plan.branch);
    if (state.target !== plan.target) throw new Error('Целевой каталог был перенаправлен символической ссылкой. Создайте новый план.');
    if (state.head !== plan.head) throw new Error('HEAD изменился после создания плана. Создайте новый план.');
    const current = await inventory(plan.target, plan.preserve);
    if (!sameInventory(current.entries, plan.before) || JSON.stringify(current.protectedPaths) !== JSON.stringify(plan.protectedPaths)) {
      throw new Error('Целевая папка изменилась после создания плана. Создайте новый план.');
    }
    const snapshot = await assertSnapshot(directory, plan.after, plan.preserve);
    const operations = changes(plan.before, plan.after, current.protectedPaths);
    await assertWritable(plan.target, operations);
    if (!operations.length) return { operations, backup: null };
    const backupDir = await mkdtemp(path.join(directory, 'backup-'));
    const backupFile = path.join(backupDir, 'backup.json');
    await copyEntries(plan.target, path.join(backupDir, 'snapshot'), plan.before);
    const backedUp = await inventory(path.join(backupDir, 'snapshot'), plan.preserve);
    if (!sameInventory(backedUp.entries, plan.before)) throw new Error('Не удалось проверить резервную копию. Цель не изменена.');
    const backup = { ...plan, kind: 'contour-sync-backup', state: 'prepared', after: expectedAfter(plan, operations) };
    await writeJson(backupFile, backup);
    // Print before the first modification so recovery is possible after interruption.
    process.stderr.write(`Резервная копия: ${backupFile}\n`);
    try {
      signal?.throwIfAborted();
      const check = await inventory(plan.target, plan.preserve);
      if (!sameInventory(check.entries, plan.before)) throw new Error('Файлы изменились во время подготовки резервной копии');
      const latest = await inspectTarget(plan.target, plan.branch);
      if (latest.head !== plan.head) throw new Error('HEAD изменился во время подготовки резервной копии');
      await executeChanges(plan.target, snapshot, operations, { signal });
      const final = await inventory(plan.target, plan.preserve);
      if (!sameInventory(final.entries, backup.after)) throw new Error('Итоговые файлы не совпали с планом');
      backup.state = 'applied';
      await writeJson(backupFile, backup);
      return { operations, backup: backupFile };
    } catch (error) {
      try {
        await restoreBackupUnlocked(backupFile);
      } catch (rollbackError) {
        throw new Error(`${error.message}. Автовосстановление не выполнено: ${rollbackError.message}. Выполните restore --backup ${backupFile}`);
      }
      throw new Error(`${error.message}. Изменения отменены. Резервная копия: ${backupFile}`);
    }
  });
}

async function restoreBackupUnlocked(filename) {
  const { manifest: backup, directory, filename: actual } = await readManifest(filename, 'contour-sync-backup');
  if (!['prepared', 'applied'].includes(backup.state)) throw new Error('Эта резервная копия уже восстановлена или имеет неизвестное состояние');
  const state = await inspectTarget(backup.target, backup.branch, { allowDirty: true });
  if (state.target !== backup.target) throw new Error('Целевой каталог был перенаправлен символической ссылкой');
  if (state.head !== backup.head) throw new Error('HEAD изменился. Автоматическое восстановление остановлено.');
  if (git(['diff', '--cached', '--name-only', '-z'], backup.target)) {
    throw new Error('В Git-индексе есть staged изменения. Сначала сохраните или уберите их из индекса.');
  }
  const snapshot = await assertSnapshot(directory, backup.before, backup.preserve);
  const current = await inventory(backup.target, backup.preserve);
  if (backup.state === 'applied') {
    if (!sameInventory(current.entries, backup.after)) throw new Error('После синхронизации были внесены изменения. Восстановление остановлено, чтобы их не потерять.');
  } else {
    for (const name of new Set([...Object.keys(current.entries), ...Object.keys(backup.before), ...Object.keys(backup.after)])) {
      const item = current.entries[name];
      if (sameEntry(backup.before[name], backup.after[name])) {
        if (!sameEntry(item, backup.before[name])) throw new Error(`Посторонние изменения: ${name}`);
      } else if (item && !sameEntry(item, backup.before[name]) && !sameEntry(item, backup.after[name])) {
        throw new Error(`Посторонние изменения: ${name}`);
      }
    }
  }
  const operations = changes(current.entries, backup.before, current.protectedPaths);
  await assertWritable(backup.target, operations);
  // A second interruption during recovery can be resumed using the same backup.
  backup.state = 'prepared';
  await writeJson(actual, backup);
  await executeChanges(backup.target, snapshot, operations);
  if (!sameInventory((await inventory(backup.target, backup.preserve)).entries, backup.before)) {
    throw new Error('Не удалось проверить результат восстановления');
  }
  backup.state = 'restored';
  await writeJson(actual, backup);
  return { operations, target: backup.target };
}

export async function restoreBackup(filename) {
  const { manifest } = await readManifest(filename, 'contour-sync-backup');
  return lockTarget(manifest.target, () => restoreBackupUnlocked(filename));
}

export async function diffPlan(filename) {
  const { manifest: plan, directory } = await readManifest(filename, 'contour-sync-plan');
  const state = await inspectTarget(plan.target, plan.branch);
  if (state.head !== plan.head || !sameInventory((await inventory(plan.target, plan.preserve)).entries, plan.before)) {
    throw new Error('Целевой репозиторий изменился. Создайте новый план.');
  }
  const snapshot = await assertSnapshot(directory, plan.after, plan.preserve);
  const before = await mkdtemp(path.join(directory, 'diff-'));
  try {
    await copyEntries(plan.target, before, plan.before);
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', before, snapshot], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || 'Не удалось построить diff');
    return result.stdout;
  } finally { await rm(before, { recursive: true, force: true }); }
}

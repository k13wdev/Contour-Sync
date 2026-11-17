import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function git(args, cwd, options = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  // A caller's Git context must not redirect commands away from the selected repository.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete env[key];
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      env,
      ...options,
    }).trimEnd();
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Git не найден. Установите Git и добавьте его в PATH.');
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Git: ${detail}`);
  }
}

export async function inspectTarget(directory, branch, { allowDirty = false } = {}) {
  const target = await realpath(directory);
  const root = await realpath(git(['rev-parse', '--show-toplevel'], target));
  if (root !== target) throw new Error('targetDir должен указывать на корень Git-репозитория');
  if (git(['ls-files', '--stage'], target).split('\n').some((line) => line.startsWith('160000 '))) {
    throw new Error('Целевой репозиторий содержит submodules: автоматическая синхронизация не поддерживается');
  }
  if (git(['ls-files', '-v'], target).split('\n').some((line) => /^[a-zS] /.test(line))) {
    throw new Error('В цели включены skip-worktree/assume-unchanged. Отключите их перед синхронизацией.');
  }
  const current = git(['branch', '--show-current'], target);
  if (!current) throw new Error('Целевой репозиторий в detached HEAD. Переключитесь на локальную ветку.');
  if (branch && current !== branch) {
    throw new Error(`Ожидалась ветка ${branch}, сейчас ${current}. Сначала выполните git switch вручную.`);
  }
  if (!allowDirty && git(['status', '--porcelain=v1', '--untracked-files=all'], target)) {
    throw new Error('В целевом репозитории есть незакоммиченные изменения. Сначала сохраните их коммитом или stash.');
  }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (existsSync(path.resolve(target, git(['rev-parse', '--git-path', marker], target)))) {
      throw new Error(`В целевом репозитории не завершена Git-операция (${marker})`);
    }
  }
  const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], target)
    .split('\0').filter(Boolean);
  return { target, branch: current, head: git(['rev-parse', 'HEAD'], target), ignored };
}

export function validateBranch(branch, label = 'исходная') {
  if (typeof branch !== 'string' || !branch || branch !== branch.trim() || branch.startsWith('-') || branch === 'HEAD') {
    throw new Error(`Некорректная ${label} ветка`);
  }
  git(['check-ref-format', `refs/heads/${branch}`]);
}

export function localBranches(directory) {
  return git(['for-each-ref', '--format=%(refname:strip=2)', '--sort=refname', 'refs/heads/'], directory)
    .split('\n').filter(Boolean);
}

export function requireLocalBranch(directory, branch) {
  validateBranch(branch, 'целевая');
  if (!localBranches(directory).includes(branch)) {
    throw new Error(`Локальная ветка "${branch}" не существует. Создайте её заранее от нужной внутренней ветки.`);
  }
}

export function switchBranch(directory, branch) {
  // Do not create tracking branches or overwrite ignored local files implicitly.
  git(['switch', '--no-guess', '--no-overwrite-ignore', '--no-recurse-submodules', '--', branch], directory);
}

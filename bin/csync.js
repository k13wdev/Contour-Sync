#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chooseBranches } from '../lib/branches.js';
import { defaultConfig, loadConfig } from '../lib/config.js';
import { git, inspectTarget } from '../lib/git.js';
import { assertWritable, inventory } from '../lib/files.js';
import { createPlan, applyPlan, restoreBackup, temporaryRoot, diffPlan } from '../lib/sync.js';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cancellation = new AbortController();
const shellArg = (value) => process.platform === 'win32' ? JSON.stringify(value) : `'${value.replaceAll("'", "'\\''")}'`;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    cancellation.abort(new Error('Операция прервана пользователем'));
  });
}

const HELP = `Contour Sync ${version} — перенос кода с предварительным просмотром

Запуск: csync <команда> [параметры]

  init       Создать пример настроек (существующий файл не перезаписывается)
  projects   Показать настроенные проекты
  doctor     Проверить Git, настройки, целевой репозиторий и временный каталог
  plan       Подготовить снимок и показать изменения, не меняя целевой проект
  diff       Показать полный diff ранее сохранённого плана
  apply      Применить ранее сохранённый план
  sync       Подготовить план и запросить подтверждение применения
  restore    Восстановить файлы из резервной копии

  --config <файл>       Настройки (по умолчанию пользовательский конфиг Contour Sync)
  --project <имя>       Имя проекта из настроек
  --source <ветка>      Откуда: ветка внешнего репозитория (без значения по умолчанию)
  --target <ветка>      Куда: локальная ветка; plan/sync переключают, doctor проверяет
  --from <каталог>      Локальный снимок вместо клонирования Git
  --output <каталог>    Новая папка для плана, снимка и резервных копий
  --temp-dir <каталог>  Временный каталог (также CONTOUR_SYNC_TMP_DIR)
  --plan <файл>         plan.json для apply/diff
  --backup <файл>       backup.json для restore
  --dry-run            Для sync: только подготовить план
  --yes                Для sync: применить без интерактивного подтверждения
  --json               Машиночитаемый вывод; без интерактивных вопросов
  --help, -h           Справка
  --version, -v        Версия

Примеры:
  csync init
  csync doctor --project frontend
  csync plan --project frontend --source develop --target import/update
  csync apply --plan /path/to/plan.json
  csync sync --project frontend --from /path/to/snapshot --target import/update
  csync restore --backup /path/to/backup.json

Требования: Node.js >=22.13.0 и Git. Сторонних зависимостей нет.
`;

function parse() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      config: { type: 'string' }, project: { type: 'string' }, source: { type: 'string' },
      target: { type: 'string' }, from: { type: 'string' }, output: { type: 'string' },
      'temp-dir': { type: 'string' }, plan: { type: 'string' }, backup: { type: 'string' },
      'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) return { command: 'help', options: values };
  if (values.version) return { command: 'version', options: values };
  if (positionals.length > 1) throw new Error('Ожидается одна команда. См. --help');
  const command = positionals[0] || (stdin.isTTY && stdout.isTTY ? 'sync' : 'help');
  const allowed = {
    init: ['config'], projects: ['config', 'json'], diff: ['plan', 'json'], doctor: ['config', 'project', 'target', 'temp-dir', 'json'],
    plan: ['config', 'project', 'source', 'target', 'from', 'output', 'temp-dir', 'json'],
    sync: ['config', 'project', 'source', 'target', 'from', 'output', 'temp-dir', 'json', 'yes', 'dry-run'],
    apply: ['plan', 'json'], restore: ['backup', 'json'], help: [], version: [],
  };
  if (!Object.hasOwn(allowed, command)) throw new Error(`Неизвестная команда: ${command}. См. --help`);
  for (const key of Object.keys(values)) {
    if (!allowed[command].includes(key)) throw new Error(`Параметр --${key} не используется командой ${command}`);
  }
  if (values.from && values.source) throw new Error('Используйте только один источник: --from или --source');
  if (values['dry-run'] && values.yes) throw new Error('--dry-run и --yes несовместимы');
  return { command, options: values };
}

async function question(message, fallback) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${message}${fallback ? ` [${fallback}]` : ''}: `, { signal: cancellation.signal });
    return answer.trim() || fallback || '';
  } finally { rl.close(); }
}

async function chooseProject(settings, options) {
  if (options.project) {
    const repo = settings.projects.find((item) => item.name === options.project);
    if (!repo) throw new Error(`Нет проекта ${options.project}. Доступны: ${settings.projects.map((item) => item.name).join(', ')}`);
    return repo;
  }
  if (settings.projects.length === 1) return settings.projects[0];
  if (!stdin.isTTY || !stdout.isTTY || options.json) throw new Error('Укажите --project');
  settings.projects.forEach((repo, index) => console.log(`${index + 1}. ${repo.name}`));
  const index = Number(await question('Выберите номер проекта')) - 1;
  if (!Number.isInteger(index) || !settings.projects[index]) throw new Error('Неверный номер проекта');
  return settings.projects[index];
}

function printPlan(result, json) {
  const { plan, filename, operations } = result;
  if (json) { console.log(JSON.stringify({ plan: filename, ...plan, operations }, null, 2)); return; }
  console.log(`\nПроект: ${plan.project}\nЦель: ${plan.target}\nВетка: ${plan.branch}`);
  if (plan.origin.commit) console.log(`Источник: ${plan.origin.branch} (${plan.origin.commit})`);
  else console.log(`Источник: ${plan.origin.directory}`);
  const labels = { add: '+', modify: '~', delete: '-' };
  for (const operation of operations) console.log(`  ${labels[operation.action]} ${JSON.stringify(operation.path)}`);
  console.log(`Изменений: ${operations.length}. Замен адресов registry: ${plan.registryChanges}.`);
  console.log(`План: ${filename}`);
  console.log(`Посмотреть diff: csync diff --plan ${shellArg(filename)}`);
  console.log(`Применить: csync apply --plan ${shellArg(filename)}`);
}

async function main() {
  const { command, options } = parse();
  if (command === 'help') { console.log(HELP); return; }
  if (command === 'version') { console.log(version); return; }
  if (command === 'init') {
    const destination = path.resolve(options.config || defaultConfig());
    const sample = await readFile(new URL('../config/contour-sync.example.json', import.meta.url));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, sample, { flag: 'wx', mode: 0o600 });
    console.log(`Созданы настройки: ${destination}\nЗаполните repo и targetDir, затем выполните doctor.`);
    return;
  }
  if (command === 'diff') {
    if (!options.plan) throw new Error('Укажите --plan <plan.json>');
    const diff = await diffPlan(options.plan);
    if (options.json) console.log(JSON.stringify({ diff }));
    else process.stdout.write(diff || 'Изменений нет.\n');
    return;
  }
  if (command === 'apply') {
    if (!options.plan) throw new Error('Укажите --plan <plan.json>');
    const result = await applyPlan(options.plan, { signal: cancellation.signal });
    console.log(options.json ? JSON.stringify(result) : `Применено изменений: ${result.operations.length}. Проверьте git diff и git status.\n${result.backup ? `Восстановление: csync restore --backup ${shellArg(result.backup)}` : 'Файлы уже совпадают.'}`);
    return;
  }
  if (command === 'restore') {
    if (!options.backup) throw new Error('Укажите --backup <backup.json>');
    const result = await restoreBackup(options.backup);
    console.log(options.json ? JSON.stringify(result) : `Файлы восстановлены: ${result.target}. Проверьте git status.`);
    return;
  }
  const settings = await loadConfig(options.config);
  if (command === 'projects') {
    const projects = settings.projects.map(({ name, targetDir, repoUrl }) => ({ name, targetDir, source: repoUrl ? 'git' : 'directory' }));
    if (options.json) console.log(JSON.stringify(projects));
    else for (const repo of projects) console.log(`${repo.name}: ${repo.targetDir} (источник: ${repo.source})`);
    return;
  }
  const repo = await chooseProject(settings, options);
  if (command === 'doctor') {
    const version = git(['--version']);
    const state = await inspectTarget(repo.targetDir, options.target);
    const rules = [...repo.preserve, ...state.ignored];
    const files = await inventory(state.target, rules);
    await assertWritable(state.target, Object.keys(files.entries).map((name) => ({ path: name })));
    const temp = await temporaryRoot(options['temp-dir'] || process.env.CONTOUR_SYNC_TMP_DIR || settings.tempDir);
    const report = { ok: true, node: process.version, git: version, config: settings.configPath, project: repo.name, target: state.target, branch: state.branch, temp, network: 'not-checked' };
    console.log(options.json ? JSON.stringify(report) : `Проверки пройдены.\nNode: ${process.version}\nGit: ${version}\nПроект: ${repo.name}\nВетка: ${state.branch}\nВременный каталог: ${temp}\nСетевой доступ к Git/Nexus не проверялся.`);
    return;
  }
  const branches = await chooseBranches(repo, options, {
    interactive: Boolean(stdin.isTTY && stdout.isTTY && !options.json),
    ask: question,
    print: (message) => console.log(message),
  });
  const result = await createPlan(settings, repo, { ...branches, signal: cancellation.signal });
  if (!options.json || command === 'plan' || options['dry-run'] || !options.yes || !result.operations.length) printPlan(result, options.json);
  if (command === 'plan' || options['dry-run'] || !result.operations.length) return;
  if (!options.yes) {
    if (!stdin.isTTY || !stdout.isTTY || options.json) {
      throw new Error(`План подготовлен. Для применения выполните apply --plan ${result.filename} или используйте sync --yes.`);
    }
    const answer = await question('Применить изменения? Введите yes', 'no');
    if (answer !== 'yes') { console.log('Применение отменено. План сохранён.'); return; }
  }
  const applied = await applyPlan(result.filename, { signal: cancellation.signal });
  console.log(options.json ? JSON.stringify({ ...applied, plan: result.filename }) : `Готово. Проверьте git diff и git status.\nРезервная копия: ${applied.backup}`);
}

// Set exitCode rather than exiting immediately: open handles and cleanup can finish.
try { await main(); }
catch (error) {
  if (process.argv.includes('--json')) console.error(JSON.stringify({ error: error.message, code: error.code || 'CONTOUR_SYNC_ERROR' }));
  else console.error(`Ошибка: ${error.message}${error.code ? ` (${error.code})` : ''}`);
  process.exitCode ||= 1;
}

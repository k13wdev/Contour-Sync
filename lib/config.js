import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function defaultConfig() {
  if (process.env.CONTOUR_SYNC_CONFIG) return path.resolve(process.env.CONTOUR_SYNC_CONFIG);
  const base = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ContourSync')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'contour-sync');
  return path.join(base, 'config.json');
}
export const DEFAULT_PRESERVE = ['.git', '.env', '.env.local', '.npmrc', '.vscode', '.idea', 'node_modules'];

export function relativeName(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
      value.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`Недопустимый относительный путь: ${JSON.stringify(value)}`);
  }
  return value;
}

function strings(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name}: ожидается массив непустых строк`);
  }
  return value;
}

function object(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}: ожидается объект`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${name}: неизвестное поле ${key}`);
}

function preserveRules(value, name) {
  return strings(value ?? [], name).map((rule) => {
    relativeName(rule);
    if (/[\*?\[\]{}]/.test(rule)) throw new Error(`${name}: используйте точные пути или имена, без glob: ${rule}`);
    return rule;
  });
}

function registry(value, name) {
  if (value === undefined) return undefined;
  object(value, name, ['from', 'to']);
  strings(value.from, `${name}.from`);
  if (!value.from.length) throw new Error(`${name}.from: список не должен быть пустым`);
  if (typeof value.to !== 'string' || !value.to) throw new Error(`${name}.to: нужен URL внутреннего реестра`);
  for (const address of [...value.from, value.to]) {
    let url;
    try { url = new URL(address); } catch { throw new Error(`Некорректный URL реестра: ${address}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('URL реестра должен быть HTTP(S), без пароля, query и fragment');
    }
  }
  return { externalRegistryUrls: value.from, internalNexusUrl: value.to };
}

export async function loadConfig(filename = defaultConfig()) {
  const configPath = path.resolve(filename);
  let settings;
  try { settings = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Нет настроек ${configPath}. Выполните: csync init`);
    throw new Error(`Не удалось прочитать ${configPath}: ${error.message}`);
  }
  object(settings, 'config', ['projects', 'preserve', 'tempDir']);
  object(settings.projects, 'projects', Object.keys(settings.projects || {}));
  if (!Object.keys(settings.projects).length) throw new Error('projects: добавьте хотя бы один проект');
  const common = preserveRules(settings.preserve, 'preserve');
  const base = path.dirname(configPath);
  if (settings.tempDir !== undefined && (typeof settings.tempDir !== 'string' || !settings.tempDir.trim())) {
    throw new Error('tempDir: ожидается непустой путь');
  }
  const projects = [];
  for (const [name, project] of Object.entries(settings.projects)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Некорректное имя проекта: ${name}`);
    object(project, `projects.${name}`, ['repo', 'targetDir', 'sourceBranch', 'preserve', 'registry']);
    if (typeof project.targetDir !== 'string' || !project.targetDir.trim()) throw new Error(`${name}: нужен targetDir`);
    if (project.repo !== undefined && (typeof project.repo !== 'string' || !project.repo.trim() || project.repo.startsWith('-'))) {
      throw new Error(`${name}: некорректный repo`);
    }
    if (project.sourceBranch !== undefined && (typeof project.sourceBranch !== 'string' || !project.sourceBranch.trim())) {
      throw new Error(`${name}: sourceBranch должна быть непустой строкой`);
    }
    projects.push({
      name, repoUrl: project.repo, targetDir: path.resolve(base, project.targetDir),
      sourceBranch: project.sourceBranch || 'main',
      preserve: [...new Set([...DEFAULT_PRESERVE, ...common, ...preserveRules(project.preserve, `${name}.preserve`)])],
      nexus: registry(project.registry, `${name}.registry`),
    });
  }
  return { projects, tempDir: settings.tempDir ? path.resolve(base, settings.tempDir) : undefined, configPath };
}

export function isPreserved(name, rules) {
  const parts = name.split('/');
  if (parts.some((part) => part.toLowerCase() === '.git')) return true;
  return rules.some((rule) => rule.includes('/')
    ? name === rule || name.startsWith(`${rule}/`)
    : parts.includes(rule));
}

export function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function rejectOverlap(first, second) {
  const [a, b] = await Promise.all([realpath(first), realpath(second)]);
  if (inside(a, b) || inside(b, a)) throw new Error(`Каталоги не должны пересекаться: ${a} и ${b}`);
}

import { readdir, lstat, mkdir, copyFile, chmod, rm, access, rmdir, rename } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isPreserved, relativeName } from './config.js';

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventory(root, rules = []) {
  const entries = Object.create(null);
  const protectedPaths = [];
  async function walk(relative = '') {
    for (const child of (await readdir(path.join(root, relative))).sort()) {
      const name = relative ? `${relative}/${child}` : child;
      relativeName(name);
      if (isPreserved(name, rules)) { protectedPaths.push(name); continue; }
      const file = path.join(root, name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Символические ссылки пока не поддерживаются: ${file}`);
      if (stat.isDirectory()) {
        entries[name] = { type: 'directory' };
        await walk(name);
      } else if (stat.isFile()) {
        entries[name] = { type: 'file', hash: await hashFile(file), executable: Boolean(stat.mode & 0o111) };
      } else throw new Error(`Неподдерживаемый тип файла: ${file}`);
    }
  }
  await walk();
  return { entries, protectedPaths };
}

export const sameEntry = (a, b) => a?.type === b?.type && a?.hash === b?.hash && a?.executable === b?.executable;

export function sameInventory(a, b) {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => Object.hasOwn(b, name) && sameEntry(a[name], b[name]));
}

export function changes(before, after, protectedPaths = []) {
  const result = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = Object.hasOwn(before, name) ? before[name] : undefined;
    const b = Object.hasOwn(after, name) ? after[name] : undefined;
    if (sameEntry(a, b)) continue;
    if (a?.type === 'directory' && b?.type !== 'directory' && protectedPaths.some((item) => item.startsWith(`${name}/`))) {
      if (b) throw new Error(`Нельзя заменить ${name}: внутри есть защищённые файлы`);
      continue;
    }
    result.push({ path: name, action: !a ? 'add' : !b ? 'delete' : 'modify', before: a, after: b });
  }
  return result;
}

export async function copyEntries(from, to, entries) {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const [name, entry] of Object.entries(entries).sort(([a], [b]) => a.split('/').length - b.split('/').length)) {
    const destination = path.join(to, name);
    if (entry.type === 'directory') await mkdir(destination, { recursive: true });
    else {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(from, name), destination, constants.COPYFILE_EXCL);
      await chmod(destination, entry.executable ? 0o700 : 0o600);
    }
  }
}

export async function assertWritable(root, operations) {
  for (const item of [root, ...operations.map((op) => path.dirname(path.join(root, op.path)))]) {
    let current = item;
    while (true) {
      try {
        const info = await lstat(current);
        if (!info.isDirectory()) { current = path.dirname(current); continue; }
        await access(current, constants.W_OK | constants.X_OK);
        break;
      }
      catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw new Error(`Нет доступа для записи: ${current} (${error.code})`);
        current = path.dirname(current);
      }
    }
  }
}

export async function executeChanges(root, source, operations, { signal } = {}) {
  const deepest = [...operations].sort((a, b) => b.path.split('/').length - a.path.split('/').length);
  for (const op of deepest) {
    signal?.throwIfAborted();
    if (op.before && (!op.after || op.before.type !== op.after.type)) {
      const filename = path.join(root, op.path);
      if (op.before.type === 'directory') await rmdir(filename);
      else await rm(filename);
    }
  }
  for (const op of deepest.reverse()) {
    signal?.throwIfAborted();
    if (!op.after) continue;
    const filename = path.join(root, op.path);
    if (op.after.type === 'directory') await mkdir(filename, { recursive: true });
    else {
      await mkdir(path.dirname(filename), { recursive: true });
      const staging = path.join(path.dirname(filename), `.contour-sync-${randomUUID()}`);
      try {
        await copyFile(path.join(source, op.path), staging, constants.COPYFILE_EXCL);
        await chmod(staging, op.after.executable ? 0o755 : 0o644);
        await rename(staging, filename);
      } finally { await rm(staging, { force: true }); }
    }
  }
}

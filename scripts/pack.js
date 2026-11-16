import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNpm } from './npm.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist');
await mkdir(destination, { recursive: true });
const [result] = JSON.parse(runNpm([
  'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', destination,
], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
const archive = path.join(destination, result.filename);
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${sha256}  ${result.filename}\n`);
console.log(`Пакет: ${archive}\nSHA-256: ${sha256}\nКонтрольная сумма: ${archive}.sha256`);
console.log(`Установка: npm install --global --offline --ignore-scripts --no-audit --no-fund ./${path.relative(root, archive)}`);

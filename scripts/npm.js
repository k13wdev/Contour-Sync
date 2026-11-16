import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Use npm's JS entry point when invoked by npm: this also works with Windows shims.
export function runNpm(args, options = {}) {
  const entry = process.env.npm_execpath;
  if (entry) return execFileSync(process.execPath, [entry, ...args], options);
  if (process.platform === 'win32') {
    return execFileSync(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args], options);
  }
  return execFileSync('npm', args, options);
}

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

const files = ['index.js', 'eslint.config.js', ...['src', 'scripts', 'test'].flatMap(sourceFiles)];
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) process.exitCode = 1;
}
if (!process.exitCode) process.stdout.write('Syntax checked ' + files.length + ' JavaScript files.\n');

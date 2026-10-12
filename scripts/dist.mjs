// Собирает дистрибутивы (установщик NSIS + портативный zip) в release\<версия>\.
// Кэши загрузок electron-builder направляются в папку проекта (.cache), а не на диск C.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  ELECTRON_CACHE: join(root, '.cache/electron'),
  ELECTRON_BUILDER_CACHE: join(root, '.cache/electron-builder'),
  // Подписи кода нет — не ищем сертификат
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};

// Кэш лежит внутри проекта, где package.json объявляет "type": "module". Инструменты electron-builder
// в кэше написаны на CommonJS — помечаем папку кэша как CommonJS, иначе они падают.
mkdirSync(env.ELECTRON_BUILDER_CACHE, { recursive: true });
writeFileSync(join(env.ELECTRON_BUILDER_CACHE, 'package.json'), '{ "type": "commonjs" }\n');

const cli = join(root, 'node_modules/electron-builder/cli.js');
const res = spawnSync(process.execPath, [cli, '--win', '--publish', 'never', ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);

// Кадры из видео через каждые N секунд — для проверки зрения на записях «Разбора записи»:
//   node scripts/video-frames.mjs <видео> <папка> [--every 30]
// Использует scripts/extract-frames (Electron из node_modules декодирует видео тем же движком, что и коуч).
// Кадры записей пользователя могут содержать ники — класть их только в .tmp (не в репозиторий).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const [video, outDir] = args.filter((a) => !a.startsWith('--'));
const everyArg = args.indexOf('--every');
const every = everyArg >= 0 ? Number(args[everyArg + 1]) : 30;
if (!video || !outDir || !(every > 0)) {
  console.error('Использование: node scripts/video-frames.mjs <видео> <папка> [--every 30]');
  process.exit(2);
}
const electron = join(root, 'node_modules/electron/dist/electron.exe');
const tool = join(root, 'scripts/extract-frames/main.cjs');
const run = (times) => {
  const r = spawnSync(electron, [tool, video, outDir, times], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`extract-frames: ${r.stderr || r.stdout}`);
  return r.stdout;
};
mkdirSync(outDir, { recursive: true });
const info = JSON.parse(/INFO (\{.*\})/.exec(run('0'))?.[1] ?? 'null');
if (!info) throw new Error('Не удалось узнать длину видео');
const times = [];
for (let t = every; t < info.d - 1; t += every) times.push(Math.round(t));
console.log(`Видео ${info.w}×${info.h}, ${Math.round(info.d)} с → ${times.length + 1} кадров`);
// Пачками, чтобы не держать одно окно Electron слишком долго
for (let i = 0; i < times.length; i += 40) run(times.slice(i, i + 40).join(','));
console.log(`Готово: ${outDir}`);

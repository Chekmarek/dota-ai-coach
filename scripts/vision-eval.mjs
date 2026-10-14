// Проверка зрения на наборе кадров (docs/VISION_DATASET.md):
//   node scripts/vision-eval.mjs <папка> [--limit N] [--per-frame]
// Папка обходится рекурсивно. Кадр с соседним .json (формат 1, есть разметка GSI наблюдателя) — «размеченный»:
// для него считается точность по каждому полю. Кадр без разметки (например, из видео «Разбора записи») —
// только проверка здравого смысла: что прочитано, не меняется ли герой туда-сюда, нет ли падений, сколько мс.
// Читатели этапов 1–3 (верхняя панель, мини-карта, полоски здоровья) подключаются в READERS по мере появления.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { decodePng } from './png.mjs';
import { frameAccessFromImage } from '../src/core/vision/image.ts';
import { recognizeHud } from '../src/core/vision/recognize-hud.ts';
import { readTopBar } from '../src/core/vision/top-bar.ts';

const root = join(import.meta.dirname, '..');
const data = (f) => JSON.parse(readFileSync(join(root, 'src/data', f), 'utf8'));

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const perFrame = args.includes('--per-frame');
// Как в коуче: кадр шире «Максимальной ширины кадра» (по умолчанию 1920) уменьшается перед разбором
const maxWidthArg = args.indexOf('--max-width');
const maxWidth = maxWidthArg >= 0 ? Number(args[maxWidthArg + 1]) : 1920;
// Только эти матчи (body.map.matchid в .json) и каждый N-й кадр — набор большой
const matchesArg = args.indexOf('--matches');
const onlyMatches = matchesArg >= 0 ? new Set(args[matchesArg + 1].split(',')) : null;
const stepArg = args.indexOf('--step');
const step = stepArg >= 0 ? Math.max(1, Number(args[stepArg + 1])) : 1;
if (!dir || !existsSync(dir)) {
  console.error('Использование: node scripts/vision-eval.mjs <папка с кадрами> [--matches id,id] [--step N] [--limit N] [--per-frame] [--max-width 1920]');
  process.exit(2);
}

// --- Читатели ---
const hudCtx = {
  layout: data('hud-layouts/dota2-default-16x9.json'),
  model: data('hud-layouts/glyphs-default.json'),
  opts: {
    heroName: { model: data('hud-layouts/glyphs-heroname.json'), names: data('hero-names.json').names },
    cooldownModel: data('hud-layouts/glyphs-cooldown.json'),
    itemTemplates: data('item-templates.json'),
  },
};
// --portraits <файл> — другие шаблоны портретов (проверка вариантов на отложенном матче)
const portraitsArg = args.indexOf('--portraits');
const portraits = portraitsArg >= 0 ? JSON.parse(readFileSync(args[portraitsArg + 1], 'utf8')) : data('hero-portraits.json');
const ok = (o) => o && o.validity === 'valid' && o.value !== null;

/**
 * Читатель: run(кадр) → результат; fields — поля для отчёта.
 *   read(r)        → значение или null (не прочитано)
 *   truth(meta)    → правильное значение из разметки или undefined (разметки нет)
 *   correct(v, t)  → совпадает ли
 *   identity       → поле — «кто это» (для счёта подмен между соседними кадрами)
 *   multi          → read и truth возвращают массивы (по ячейкам), считается каждый элемент
 */
/** Правда по ячейке верхней панели: герой из GSI наблюдателя с тем же номером игрока */
const heroBySlot = (m, slot) => m.spectator?.heroes?.find((h) => h.slot === slot);
const READERS = [
  {
    id: 'hud',
    nameRu: 'Нижняя панель и часы (существующее зрение)',
    run: (frame) => recognizeHud(frame, hudCtx.layout, hudCtx.model, 0, hudCtx.opts),
    ms: (r) => r.durationMs,
    fields: [
      {
        id: 'clock',
        nameRu: 'Игровое время (±1 с)',
        read: (r) => (ok(r.fields.gameClock) ? r.fields.gameClock.value : null),
        truth: (m) => (typeof m.spectator?.clock === 'number' ? Math.trunc(m.spectator.clock) : undefined),
        correct: (v, t) => Math.abs(v - t) <= 1,
      },
      {
        id: 'scoreRadiant',
        nameRu: 'Счёт Сил Света',
        read: (r) => (ok(r.fields.scoreRadiant) ? r.fields.scoreRadiant.value : null),
        truth: (m) => (typeof m.body?.map?.radiant_score === 'number' ? m.body.map.radiant_score : undefined),
        correct: (v, t) => v === t,
      },
      {
        id: 'scoreDire',
        nameRu: 'Счёт Сил Тьмы',
        read: (r) => (ok(r.fields.scoreDire) ? r.fields.scoreDire.value : null),
        truth: (m) => (typeof m.body?.map?.dire_score === 'number' ? m.body.map.dire_score : undefined),
        correct: (v, t) => v === t,
      },
      {
        id: 'dayNight',
        nameRu: 'День / ночь',
        read: (r) => (ok(r.dayNight) ? r.dayNight.value : null),
        truth: (m) => (typeof m.spectator?.daytime === 'boolean' ? (m.spectator.daytime ? 'day' : 'night') : undefined),
        correct: (v, t) => v === t,
      },
      {
        id: 'heroName',
        nameRu: 'Имя героя на нижней панели',
        identity: true,
        read: (r) => (ok(r.heroName) ? r.heroName.value.name : null),
        // В режиме наблюдателя нижняя панель показывает выбранного героя — кого именно, GSI не сообщает
        truth: () => undefined,
        correct: () => false,
      },
    ],
  },
  {
    id: 'topbar',
    nameRu: 'Верхняя панель (этап 1): по 10 ячеек на кадр',
    run: (frame) => readTopBar(frame, hudCtx.layout, portraits, hudCtx.model),
    ms: (r) => r.durationMs,
    fields: [
      {
        id: 'hero',
        nameRu: 'Герой в ячейке',
        multi: true,
        identity: true,
        read: (r) => r.slots.map((s) => s.heroKey),
        truth: (m) => (m.spectator ? Array.from({ length: 10 }, (_, i) => heroBySlot(m, i)?.heroKey ?? undefined) : undefined),
        correct: (v, t) => v === t,
      },
      {
        id: 'alive',
        nameRu: 'Жив / мёртв',
        multi: true,
        read: (r) => r.slots.map((s) => s.alive),
        truth: (m) => (m.spectator ? Array.from({ length: 10 }, (_, i) => (typeof heroBySlot(m, i)?.alive === 'boolean' ? heroBySlot(m, i).alive : undefined)) : undefined),
        correct: (v, t) => v === t,
      },
      {
        id: 'respawn',
        // Экран округляет секунды вверх, GSI — вниз: на кадре таймер на 1 с больше (проверено по часам того же кадра)
        nameRu: 'Таймер возрождения ±1 с (мёртвые)',
        multi: true,
        read: (r) => r.slots.map((s) => s.respawnSec),
        // Только мёртвые с таймером: у живых правды нет
        truth: (m) => (m.spectator ? Array.from({ length: 10 }, (_, i) => { const h = heroBySlot(m, i); return h && h.alive === false && h.respawnSec > 0 ? h.respawnSec + 1 : undefined; }) : undefined),
        correct: (v, t) => Math.abs(v - t) <= 1,
      },
    ],
  },
  // Этап 2: мини-карта (minimap.ts), этап 3: полоски здоровья (health-bars.ts) — пока не написаны.
];
const PENDING = ['мини-карта (этап 2)', 'полоски здоровья (этап 3)'];

/** Уменьшение по площади (усреднение пикселей) — близко к createImageBitmap(resizeQuality: medium/high) */
function downscale(img, w) {
  if (img.width <= w) return img;
  const h = Math.round((img.height * w) / img.width);
  const out = new Uint8ClampedArray(w * h * 4);
  const fx = img.width / w;
  const fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

// --- Кадры ---
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d).sort()) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.toLowerCase().endsWith('.png')) files.push(p);
  }
};
walk(dir);
const matchOf = (png) => {
  try {
    return JSON.parse(readFileSync(png.replace(/.png$/i, '.json'), 'utf8'))?.body?.map?.matchid ?? null;
  } catch {
    return null;
  }
};
const frames = (onlyMatches ? files.filter((f) => onlyMatches.has(matchOf(f))) : files).filter((_, i) => i % step === 0).slice(0, limit);

const stats = new Map(); // readerId.fieldId → { withTruth, read, correct, readNoTruth }
const st = (key) => stats.get(key) ?? (stats.set(key, { withTruth: 0, read: 0, correct: 0, readAny: 0, total: 0 }), stats.get(key));
const ms = new Map();
const swaps = new Map();
const lastIdentity = new Map();
let labeled = 0;
let crashes = 0;
const crashSamples = [];

for (const file of frames) {
  const metaPath = file.replace(/\.png$/i, '.json');
  let meta = null;
  if (existsSync(metaPath)) {
    try {
      const m = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (m && m.format === 1) meta = m;
    } catch {
      /* битый .json — кадр считается неразмеченным */
    }
  }
  if (meta?.spectator) labeled++;
  let frame;
  try {
    frame = frameAccessFromImage(downscale(decodePng(readFileSync(file)), maxWidth));
  } catch (err) {
    crashes++;
    if (crashSamples.length < 5) crashSamples.push(`${relative(dir, file)}: PNG не читается (${err.message})`);
    continue;
  }
  const row = [relative(dir, file)];
  for (const reader of READERS) {
    let r;
    try {
      r = reader.run(frame);
    } catch (err) {
      crashes++;
      if (crashSamples.length < 5) crashSamples.push(`${relative(dir, file)}: ${reader.id}: ${err.message}`);
      continue;
    }
    const t = reader.ms(r);
    const m = ms.get(reader.id) ?? [];
    m.push(t);
    ms.set(reader.id, m);
    for (const f of reader.fields) {
      const key = `${reader.id}.${f.id}`;
      const s = st(key);
      const vs = f.multi ? f.read(r) : [f.read(r)];
      const ts = meta ? (f.multi ? f.truth(meta) ?? [] : [f.truth(meta)]) : [];
      const cells = [];
      vs.forEach((v, k) => {
        s.total++;
        if (v !== null) s.readAny++;
        const truth = ts[k];
        if (truth !== undefined) {
          s.withTruth++;
          if (v !== null) {
            s.read++;
            if (f.correct(v, truth)) s.correct++;
            else if (perFrame) cells.push(`✗${k}:${v}≠${truth}`);
          }
        }
        if (f.identity && v !== null) {
          // Подмена — только внутри одного матча: в новом матче в ячейке законно другой герой
          const ik = `${key}#${meta?.body?.map?.matchid ?? ''}#${k}`;
          const prev = lastIdentity.get(ik);
          if (prev !== undefined && prev !== v) swaps.set(key, (swaps.get(key) ?? 0) + 1);
          lastIdentity.set(ik, v);
        }
      });
      if (f.multi) row.push(`${f.id}: ${cells.join(' ') || 'ok'}`);
      else row.push(`${f.id}=${vs[0] === null ? '—' : vs[0]}${ts[0] !== undefined ? `(${ts[0]})` : ''}`);
    }
    row.push(`${t.toFixed(1)}мс`);
  }
  if (perFrame) console.log(row.join('\t'));
}

// --- Отчёт ---
const pct = (a, b) => (b === 0 ? '—' : `${((100 * a) / b).toFixed(1)}%`);
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
console.log(`\nКадров: ${frames.length} (размечено GSI наблюдателя: ${labeled}, без разметки: ${frames.length - labeled})`);
console.log(`Падений: ${crashes}${crashSamples.length ? `\n  ${crashSamples.join('\n  ')}` : ''}`);
for (const reader of READERS) {
  const t = ms.get(reader.id) ?? [];
  const avg = t.length ? t.reduce((a, b) => a + b, 0) / t.length : null;
  console.log(`\n${reader.nameRu}: ${avg === null ? '—' : `${avg.toFixed(1)} мс в среднем, медиана ${median(t).toFixed(1)}, максимум ${Math.max(...t).toFixed(1)}`}`);
  console.log('  поле'.padEnd(34) + 'прочитано (все кадры)'.padEnd(24) + 'с разметкой  прочитано  верно из прочитанных  верно из размеченных');
  for (const f of reader.fields) {
    const s = st(`${reader.id}.${f.id}`);
    console.log(
      `  ${f.nameRu}`.padEnd(34) +
        `${s.readAny}/${s.total} (${pct(s.readAny, s.total)})`.padEnd(24) +
        `${String(s.withTruth).padEnd(13)}${String(s.read).padEnd(11)}${pct(s.correct, s.read).padEnd(22)}${pct(s.correct, s.withTruth)}` +
        (f.identity ? `   смен между соседними кадрами: ${swaps.get(`${reader.id}.${f.id}`) ?? 0}` : ''),
    );
  }
}
console.log(`\nЕщё не написаны: ${PENDING.join(', ')}.`);
if (labeled === 0) console.log('Разметки нет: точность не посчитать, только проверка здравого смысла (см. docs/VISION_DATASET.md).');

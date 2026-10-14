// Портреты героев из файлов Dota 2 на этом компьютере — только для скрипта разработчика (разрешение владельца
// 2026-10-14: читать файлы игры, чтобы получить все облики героев, в т. ч. арканы и персоны; сам коуч файлы
// игры не читает). Только чтение. Картинки сохраняются в .cache (в git не попадают), в проект идут только числа
// шаблонов (scripts/make-portrait-templates.ts).
//   node scripts/extract-game-portraits.mjs [папка «dota 2 beta»]
// Результат: .cache/icons/<патч>/game-portraits/<имя>.png + manifest.json
// Текстуры Source 2 (.vtex_c): заголовок ресурса, блок DATA с заголовком VTEX, пиксели — сразу после ресурса.
// Форматы: DXT1 (1), DXT5 (2), RGBA8888 (4), PNG внутри текстуры (16), BGRA8888 (28); остальные пропускаются с пометкой.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import { readVpkDir, readVpkFile } from './vpk.mjs';

const root = join(import.meta.dirname, '..');
const dotaDir = process.argv[2] ?? 'C:/Program Files (x86)/Steam/steamapps/common/dota 2 beta';
const patch = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8')).patch;
const out = join(root, '.cache/icons', patch, 'game-portraits');
mkdirSync(out, { recursive: true });

const vpk = readVpkDir(join(dotaDir, 'game/dota/pak01_dir.vpk'));
const PREFIX = 'panorama/images/heroes/';
const files = [...vpk.entries.keys()].filter((k) => k.startsWith(PREFIX) && !k.slice(PREFIX.length).includes('/') && k.endsWith('_png.vtex_c'));

/** RGB565 → [r, g, b] */
const c565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];

/** Блок цвета BC1 (8 байт) → 16 цветов RGB; alpha1 — у DXT1 при c0 <= c1 четвёртый цвет прозрачный */
function colorBlock(b, o, dxt1) {
  const c0 = b.readUInt16LE(o), c1 = b.readUInt16LE(o + 2);
  const p0 = c565(c0), p1 = c565(c1);
  const pal = [p0, p1];
  if (!dxt1 || c0 > c1) {
    pal.push(p0.map((v, i) => (2 * v + p1[i]) / 3), p0.map((v, i) => (v + 2 * p1[i]) / 3));
  } else {
    pal.push(p0.map((v, i) => (v + p1[i]) / 2), [0, 0, 0]);
  }
  const idx = b.readUInt32LE(o + 4);
  return Array.from({ length: 16 }, (_, k) => ({ rgb: pal[(idx >> (2 * k)) & 3], transparent: dxt1 && c0 <= c1 && ((idx >> (2 * k)) & 3) === 3 }));
}

/** Блок прозрачности BC3 (8 байт) → 16 значений */
function alphaBlock(b, o) {
  const a0 = b[o], a1 = b[o + 1];
  const pal = [a0, a1];
  if (a0 > a1) for (let k = 1; k <= 6; k++) pal.push(((7 - k) * a0 + k * a1) / 7);
  else {
    for (let k = 1; k <= 4; k++) pal.push(((5 - k) * a0 + k * a1) / 5);
    pal.push(0, 255);
  }
  let bits = 0n;
  for (let k = 0; k < 6; k++) bits |= BigInt(b[o + 2 + k]) << BigInt(8 * k);
  return Array.from({ length: 16 }, (_, k) => pal[Number((bits >> BigInt(3 * k)) & 7n)]);
}

function decode(buf) {
  const fileSize = buf.readUInt32LE(0);
  let p = 8 + buf.readUInt32LE(8);
  let data = -1;
  for (let i = 0; i < buf.readUInt32LE(12); i++, p += 12) if (buf.toString('ascii', p, p + 4) === 'DATA') data = p + 4 + buf.readUInt32LE(p + 4);
  if (data < 0) throw new Error('нет блока DATA');
  const w = buf.readUInt16LE(data + 20), h = buf.readUInt16LE(data + 22), format = buf[data + 26], mips = buf[data + 27];
  const px = new Uint8Array(w * h * 4);
  let o = fileSize;
  // 16: внутри — обычный PNG (самый большой мип)
  if (format === 16) {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const starts = [];
    for (let i = buf.indexOf(sig, o); i >= 0; i = buf.indexOf(sig, i + 1)) starts.push(i);
    if (!starts.length) throw new Error('PNG внутри не найден');
    const img = decodePng(buf.subarray(starts[starts.length - 1]));
    return { w: img.width, h: img.height, format, px: new Uint8Array(img.data) };
  }
  // Мипы лежат от меньшего к большему: самый большой — последний
  const size = (mw, mh) => (format === 4 || format === 28 ? mw * mh * 4 : Math.ceil(mw / 4) * Math.ceil(mh / 4) * (format === 1 ? 8 : 16));
  for (let m = mips - 1; m > 0; m--) o += size(Math.max(1, w >> m), Math.max(1, h >> m));
  if (o + size(w, h) > buf.length) throw new Error(`данных меньше, чем нужно (формат ${format}, сжатие мипов?)`);
  if (format === 4) {
    px.set(buf.subarray(o, o + w * h * 4));
  } else if (format === 28) {
    for (let i = 0; i < w * h * 4; i += 4) {
      px[i] = buf[o + i + 2];
      px[i + 1] = buf[o + i + 1];
      px[i + 2] = buf[o + i];
      px[i + 3] = buf[o + i + 3];
    }
  } else if (format === 1 || format === 2) {
    const bs = format === 1 ? 8 : 16;
    for (let by = 0; by < Math.ceil(h / 4); by++)
      for (let bx = 0; bx < Math.ceil(w / 4); bx++) {
        const bo = o + (by * Math.ceil(w / 4) + bx) * bs;
        const alpha = format === 2 ? alphaBlock(buf, bo) : null;
        const col = colorBlock(buf, format === 2 ? bo + 8 : bo, format === 1);
        for (let k = 0; k < 16; k++) {
          const x = bx * 4 + (k % 4), y = by * 4 + Math.floor(k / 4);
          if (x >= w || y >= h) continue;
          const i = (y * w + x) * 4;
          if (alpha) {
            // DXT5 портретов Panorama — цвет в YCoCg: яркость в альфе, Co и Cg в R и G, масштаб в B
            // (проверено: базовые портреты совпадают с картинками героев на сервере Valve)
            const [r, g, b] = col[k].rgb.map((v) => v / 255);
            const scale = 1 / ((255 / 8) * b + 1);
            const co = (r - 0.5) * scale, cg = (g - 0.5) * scale, Y = alpha[k] / 255;
            px[i] = Math.max(0, Math.min(255, (Y + co - cg) * 255));
            px[i + 1] = Math.max(0, Math.min(255, (Y + cg) * 255));
            px[i + 2] = Math.max(0, Math.min(255, (Y - co - cg) * 255));
            px[i + 3] = 255;
          } else {
            px[i] = col[k].rgb[0];
            px[i + 1] = col[k].rgb[1];
            px[i + 2] = col[k].rgb[2];
            px[i + 3] = col[k].transparent ? 0 : 255;
          }
        }
      }
  } else throw new Error(`формат ${format} не поддерживается`);
  return { w, h, format, px };
}

const done = [];
const skipped = [];
for (const f of files) {
  const name = f.slice(PREFIX.length).replace(/^npc_dota_hero_/, '').replace(/_png\.vtex_c$/, '');
  try {
    const t = decode(readVpkFile(vpk, f));
    writeFileSync(join(out, `${name}.png`), encodePng(t.w, t.h, t.px));
    done.push({ name, w: t.w, h: t.h, format: t.format });
  } catch (e) {
    skipped.push({ name, error: String(e.message ?? e) });
  }
}
writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify({ patch, source: `файлы Dota 2 на этом компьютере: ${PREFIX}*.vtex_c (pak01_dir.vpk)`, retrievedAt: new Date().toISOString(), done, skipped }, null, 1),
);
console.log(`Портретов: ${done.length}, пропущено ${skipped.length} → ${out}`);
for (const s of skipped.slice(0, 10)) console.log(`  ✗ ${s.name}: ${s.error}`);

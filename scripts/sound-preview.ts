// Звуковые сигналы в WAV — послушать без игры и без коуча:
//   node scripts/sound-preview.ts [громкость 0…1, по умолчанию 0.3]  → .tmp/sounds/<сигнал>.wav и all.wav (все подряд)
// Расчёт — src/core/sound/render.ts (та же огибающая, что в окне коуча).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOUND_CUE_IDS, SOUND_CUES } from '../src/core/sound/cues.ts';
import { renderTone, toWav } from '../src/core/sound/render.ts';

const volume = Number(process.argv[2] ?? 0.3);
const dir = join(import.meta.dirname, '../.tmp/sounds');
mkdirSync(dir, { recursive: true });
const ids = [...SOUND_CUE_IDS, 'toggle-on', 'toggle-off'] as const;
const gap = new Float32Array(44_100 * 0.8);
const parts: Float32Array[] = [];
for (const id of ids) {
  const s = renderTone(id, volume);
  writeFileSync(join(dir, `${id}.wav`), toWav(s));
  parts.push(s, gap);
  console.log(`${id}: ${id in SOUND_CUES ? SOUND_CUES[id as keyof typeof SOUND_CUES].nameRu : 'подтверждение клавиши'}, ${Math.round((s.length / 44_100) * 1000)} мс`);
}
const all = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
let o = 0;
for (const p of parts) all.set(p, (o += p.length) - p.length);
writeFileSync(join(dir, 'all.wav'), toWav(all));
console.log(`Готово: ${dir}`);

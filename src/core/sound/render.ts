// Расчёт звука сигнала в отсчёты — та же огибающая, что в окне коуча (src/renderer/sound/player.ts): плавная атака,
// экспоненциальное затухание до тишины. Для проверки «без щелчков» в тестах и WAV-файлов (scripts/sound-preview.ts).
import { SOUND_ATTACK_MS, SOUND_RELEASE_MS, soundNotes, type SoundNote, type SoundToneId } from './cues.ts';

const FLOOR = 0.0001;

/** Громкость ноты в момент t (с от начала ноты): как setValueAtTime + exponentialRampToValueAtTime в Web Audio */
function envelope(n: SoundNote, t: number): number {
  const attack = SOUND_ATTACK_MS / 1000;
  const end = (n.durMs + SOUND_RELEASE_MS) / 1000;
  const peak = Math.max(0.0002, n.gain);
  if (t < 0 || t > end) return 0;
  if (t <= attack) return FLOOR * Math.pow(peak / FLOOR, t / attack);
  return peak * Math.pow(FLOOR / peak, (t - attack) / (end - attack));
}

/** Отсчёты сигнала (моно, −1…1) с общей громкостью volume */
export function renderTone(id: SoundToneId, volume: number, sampleRate = 44_100): Float32Array {
  const notes = soundNotes(id);
  const lenSec = Math.max(...notes.map((n) => n.startMs + n.durMs)) / 1000 + SOUND_RELEASE_MS / 1000 + 0.02;
  const out = new Float32Array(Math.ceil(lenSec * sampleRate));
  for (const n of notes) {
    const s0 = n.startMs / 1000;
    for (let i = 0; i < out.length; i++) {
      const t = i / sampleRate - s0;
      const e = envelope(n, t);
      if (e === 0) continue;
      const ph = 2 * Math.PI * n.freq * t;
      const w = n.wave === 'sine' ? Math.sin(ph) : (2 / Math.PI) * Math.asin(Math.sin(ph));
      out[i]! += volume * e * w;
    }
  }
  return out;
}

/** WAV 16 бит моно */
export function toWav(samples: Float32Array, sampleRate = 44_100): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true));
  return new Uint8Array(buf);
}

// Синтез звуковых сигналов (Web Audio, без файлов) по определениям src/core/sound/cues.ts.
// Любая ошибка звука проглатывается: подсказки и интерфейс работают как без звука.
import { SOUND_ATTACK_MS, SOUND_RELEASE_MS, soundNotes, type SoundToneId } from '@core/sound/cues.ts';
import { SOUND_MAX_AGE_MS } from '@core/sound/director.ts';
import type { SoundPlayMessage } from '@shared/ipc';

let ctx: AudioContext | null = null;
let broken = false;

function audio(): AudioContext | null {
  if (broken) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return ctx;
  } catch (err) {
    broken = true;
    console.warn('Звук недоступен', err);
    return null;
  }
}

/** Сыграть сигнал с громкостью 0…1. Возвращает false, если звук не сыгран */
export function playTone(tone: SoundToneId, volume: number): boolean {
  if (!(volume > 0)) return false;
  const ac = audio();
  if (!ac) return false;
  try {
    const t0 = ac.currentTime + 0.01;
    const master = ac.createGain();
    master.gain.value = Math.min(1, volume);
    master.connect(ac.destination);
    let end = t0;
    for (const n of soundNotes(tone)) {
      const start = t0 + n.startMs / 1000;
      const attack = (n.attackMs ?? SOUND_ATTACK_MS) / 1000;
      const stop = start + n.durMs / 1000 + SOUND_RELEASE_MS / 1000;
      const osc = ac.createOscillator();
      osc.type = n.wave;
      osc.frequency.value = n.freq;
      const g = ac.createGain();
      // плавная атака и экспоненциальное затухание до тишины — без щелчков в начале и в конце
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.gain), start + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, stop);
      osc.connect(g).connect(master);
      osc.start(start);
      osc.stop(stop + 0.02);
      end = Math.max(end, stop);
    }
    setTimeout(() => master.disconnect(), Math.ceil((end - ac.currentTime) * 1000) + 200);
    return true;
  } catch (err) {
    console.warn('Сигнал не сыгран', tone, err);
    return false;
  }
}

/** Сигнал из main: запоздавший больше чем на 2 с (окно было занято) — не играть */
export function playMessage(m: SoundPlayMessage, nowMs = Date.now()): boolean {
  if (nowMs - m.atMs > SOUND_MAX_AGE_MS) return false;
  return playTone(m.tone, m.volume);
}

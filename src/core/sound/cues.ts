// Звуковые сигналы: все определения в одном месте — чтобы перерисовать звук, достаточно поменять числа здесь.
// Звук синтезируется в окне коуча (Web Audio, src/renderer/sound/player.ts), файлов нет.
// Чистые данные: без DOM и Electron.

/** Сигналы, которые пользователь включает и выключает по одному */
export const SOUND_CUE_IDS = ['danger', 'ult', 'item', 'rune', 'timing', 'review'] as const;
export type SoundCueId = (typeof SOUND_CUE_IDS)[number];
/** Служебные сигналы: подтверждение горячей клавиши «звук вкл/выкл» (в настройках не выключаются) */
export type SoundToneId = SoundCueId | 'toggle-on' | 'toggle-off';

/** Одна нота: частота, начало и длина (мс), форма волны, громкость относительно общей (0…1) */
export interface SoundNote {
  freq: number;
  startMs: number;
  durMs: number;
  wave: 'sine' | 'triangle';
  gain: number;
}

export interface SoundCueDef {
  /** Название в настройках */
  nameRu: string;
  /** Когда звучит — для настроек */
  whenRu: string;
  /** Чем выше, тем важнее: при нескольких сигналах сразу звучит важнейший, опасность — всегда первой */
  priority: number;
  /** Тот же сигнал не чаще (мс) */
  cooldownMs: number;
  /** Звучит и в драке (остальные в драке молчат) */
  inFight: boolean;
  notes: readonly SoundNote[];
}

/** Атака и затухание ноты (мс): плавные, без щелчков */
export const SOUND_ATTACK_MS = 12;
export const SOUND_RELEASE_MS = 90;

// Ноты (Гц): мягкие и созвучные — из до-мажорной пентатоники и соседних
const N = { A3: 220, G4: 392, B4: 493.88, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98 };

export const SOUND_CUES: Record<SoundCueId, SoundCueDef> = {
  danger: {
    nameRu: 'Опасность',
    whenRu: 'подсказки об опасности: пропали враги, ганк, смок, мало здоровья, «Отходи»',
    priority: 5,
    cooldownMs: 8000,
    inFight: true,
    // мягкая нисходящая кварта
    notes: [
      { freq: N.E5, startMs: 0, durMs: 130, wave: 'triangle', gain: 0.55 },
      { freq: N.B4, startMs: 140, durMs: 160, wave: 'triangle', gain: 0.5 },
    ],
  },
  ult: {
    nameRu: 'Ульта готова',
    whenRu: 'ульта снова готова после перезарядки или только что изучена',
    priority: 4,
    cooldownMs: 20_000,
    inFight: false,
    // яркий восходящий «динь»: квинта вверх и тихий обертон
    notes: [
      { freq: N.G5, startMs: 0, durMs: 100, wave: 'sine', gain: 0.4 },
      { freq: N.D6, startMs: 80, durMs: 220, wave: 'sine', gain: 0.45 },
      { freq: N.G6, startMs: 80, durMs: 180, wave: 'sine', gain: 0.08 },
    ],
  },
  item: {
    nameRu: 'Хватает на предмет',
    whenRu: 'золота хватает на следующий предмет сборки',
    priority: 3,
    cooldownMs: 60_000,
    inFight: false,
    // тёплый аккорд до-мажор с лёгким разбегом
    notes: [
      { freq: N.C5, startMs: 0, durMs: 300, wave: 'sine', gain: 0.32 },
      { freq: N.E5, startMs: 30, durMs: 270, wave: 'sine', gain: 0.26 },
      { freq: N.G5, startMs: 60, durMs: 240, wave: 'sine', gain: 0.22 },
    ],
  },
  rune: {
    nameRu: 'Скоро руна',
    whenRu: 'скоро руна (сила, богатство, вода) или лотос',
    priority: 2,
    // руны идут парами (богатство и вода, сила) через 30 с — звучит раз в минуту, на экране — все
    cooldownMs: 60_000,
    inFight: false,
    // лёгкий «блеск»: три коротких высоких ноты вверх
    notes: [
      { freq: N.E6, startMs: 0, durMs: 70, wave: 'sine', gain: 0.18 },
      { freq: N.G6, startMs: 60, durMs: 70, wave: 'sine', gain: 0.16 },
      { freq: N.C6 * 2, startMs: 120, durMs: 140, wave: 'sine', gain: 0.12 },
    ],
  },
  timing: {
    nameRu: 'Тайминг',
    whenRu: 'стак, Рошан, Мучитель, смена суток, святилище, нейтральные предметы, аегис',
    priority: 1,
    cooldownMs: 20_000,
    inFight: false,
    // мягкий низкий «ток»
    notes: [
      { freq: N.A3, startMs: 0, durMs: 150, wave: 'triangle', gain: 0.6 },
      { freq: N.A5, startMs: 0, durMs: 60, wave: 'sine', gain: 0.06 },
    ],
  },
  review: {
    nameRu: 'Разбор готов',
    whenRu: 'готов разбор смерти или матча',
    priority: 2,
    cooldownMs: 10_000,
    inFight: false,
    // спокойные две ноты вверх (кварта)
    notes: [
      { freq: N.G4, startMs: 0, durMs: 160, wave: 'sine', gain: 0.38 },
      { freq: N.C5, startMs: 170, durMs: 130, wave: 'sine', gain: 0.34 },
    ],
  },
};

/** Подтверждение горячей клавиши: короткие две ноты вверх (вкл) и вниз (выкл) */
export const SOUND_TOGGLE_NOTES: Record<'toggle-on' | 'toggle-off', readonly SoundNote[]> = {
  'toggle-on': [
    { freq: N.C5, startMs: 0, durMs: 70, wave: 'sine', gain: 0.3 },
    { freq: N.G5, startMs: 70, durMs: 90, wave: 'sine', gain: 0.3 },
  ],
  'toggle-off': [
    { freq: N.G5, startMs: 0, durMs: 70, wave: 'sine', gain: 0.3 },
    { freq: N.C5, startMs: 70, durMs: 90, wave: 'sine', gain: 0.3 },
  ],
};

export function soundNotes(id: SoundToneId): readonly SoundNote[] {
  return id === 'toggle-on' || id === 'toggle-off' ? SOUND_TOGGLE_NOTES[id] : SOUND_CUES[id].notes;
}

/** Длина звука (мс) — от начала первой ноты до конца затухания последней */
export function soundLengthMs(id: SoundToneId): number {
  return Math.max(...soundNotes(id).map((n) => n.startMs + n.durMs)) + SOUND_RELEASE_MS;
}


/** Какой сигнал у подсказки (по правилу, категории и важности); null — подсказка без звука */
export function cueForHint(h: { ruleId: string; category: string; priority: string; icon?: string | null }): SoundCueId | null {
  const r = h.ruleId;
  if (h.category === 'danger' && h.priority !== 'info') return 'danger';
  if (r === 'fight.disengage') return 'danger';
  if (r === 'fight.ult-ready') return 'ult';
  if (r === 'economy.gold' && typeof h.icon === 'string' && h.icon.startsWith('item:')) return 'item';
  if (r.startsWith('timing.rune-') || r === 'timing.lotus') return 'rune';
  if (['timing.stack', 'timing.roshan-respawn', 'timing.tormentor', 'timing.day-night', 'timing.shrine-of-wisdom', 'timing.neutral-tier', 'timing.aegis-end', 'macro.roshan-killed'].includes(r)) return 'timing';
  if (r === 'review.death' || r === 'review.match') return 'review';
  return null;
}

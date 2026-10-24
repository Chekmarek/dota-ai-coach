// Звуковые сигналы: все определения в одном месте — чтобы перерисовать звук, достаточно поменять числа здесь.
// Звук синтезируется в окне коуча (Web Audio, src/renderer/sound/player.ts), файлов нет.
// Чистые данные: без DOM и Electron.
//
// Один стиль на все сигналы (решение владельца 2026-10-22): мягкие волны, ноты одной гаммы (до-мажорная пентатоника
// и соседние созвучные), у каждого действия свой короткий мотив. Насколько звук заметен — по срочности:
//   срочно  — ярко: треугольная волна с октавой сверху, быстрая атака, громче, звучит и в драке;
//   совет   — средне: чистый синус;
//   фон     — тихо и мягко: синус, медленная атака, примерно в 4 раза тише срочного.

export type SoundTier = 'urgent' | 'advice' | 'background';
export const SOUND_TIER_RU: Record<SoundTier, string> = { urgent: 'Срочные — ярко и заметно', advice: 'Советы — средне', background: 'Фоновые — тихо, не отвлекают' };
export const SOUND_TIERS: readonly SoundTier[] = ['urgent', 'advice', 'background'];

/** Сигналы, которые пользователь включает и выключает по одному (порядок — как в настройках и по важности) */
export const SOUND_CUE_IDS = ['danger', 'retreat', 'engage', 'ult', 'focus', 'item', 'buy', 'skill', 'regen', 'farm', 'team', 'buyback', 'building', 'aegis', 'review', 'rune', 'timing', 'shop', 'map'] as const;
export type SoundCueId = (typeof SOUND_CUE_IDS)[number];
/** Служебные сигналы: подтверждение горячей клавиши «звук вкл/выкл» (в настройках не выключаются) */
export type SoundToneId = SoundCueId | 'toggle-on' | 'toggle-off';

/** Одна нота: частота, начало и длина (мс), форма волны, громкость относительно общей (0…1), атака (мс) */
export interface SoundNote {
  freq: number;
  startMs: number;
  durMs: number;
  wave: 'sine' | 'triangle';
  gain: number;
  attackMs?: number;
}

export interface SoundCueDef {
  /** Название в настройках */
  nameRu: string;
  /** Когда звучит — для настроек */
  whenRu: string;
  tier: SoundTier;
  /** Тот же сигнал не чаще (мс) */
  cooldownMs: number;
  notes: readonly SoundNote[];
}

/** Атака и затухание ноты по умолчанию (мс): плавные, без щелчков */
export const SOUND_ATTACK_MS = 12;
export const SOUND_RELEASE_MS = 90;

/** Стиль уровня: волна, громкость, атака; срочные — с тихой октавой сверху (яркость) */
const TIER_STYLE: Record<SoundTier, { wave: 'sine' | 'triangle'; gain: number; attackMs: number; octave: number }> = {
  urgent: { wave: 'triangle', gain: 0.55, attackMs: 6, octave: 0.12 },
  advice: { wave: 'sine', gain: 0.32, attackMs: 12, octave: 0 },
  background: { wave: 'sine', gain: 0.14, attackMs: 30, octave: 0 },
};

// Ноты (Гц)
const N = { A3: 220, E4: 329.63, G4: 392, A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, C7: 2093 };

/** Мотив в стиле уровня: [нота, начало мс, длина мс, громкость ×] */
function motif(tier: SoundTier, steps: readonly (readonly [number, number, number, number?])[]): SoundNote[] {
  const st = TIER_STYLE[tier];
  return steps.flatMap(([freq, startMs, durMs, k = 1]) => {
    const main: SoundNote = { freq, startMs, durMs, wave: st.wave, gain: st.gain * k, attackMs: st.attackMs };
    return st.octave ? [main, { freq: freq * 2, startMs, durMs, wave: 'sine' as const, gain: st.octave * k, attackMs: st.attackMs }] : [main];
  });
}

export const SOUND_CUES: Record<SoundCueId, SoundCueDef> = {
  // ---- Срочные ----
  danger: {
    nameRu: 'Опасность',
    whenRu: 'пропали враги, ганк, смок, невидимка, вы слишком глубоко',
    tier: 'urgent',
    cooldownMs: 8000,
    // нисходящая кварта
    notes: motif('urgent', [[N.E5, 0, 130], [N.B4, 140, 160]]),
  },
  retreat: {
    nameRu: 'Отходи',
    whenRu: '«Отходите», мало здоровья, высокий риск смерти',
    tier: 'urgent',
    cooldownMs: 6000,
    // быстрое трезвучие вниз
    notes: motif('urgent', [[N.G5, 0, 80], [N.E5, 85, 80], [N.C5, 170, 140]]),
  },
  engage: {
    nameRu: 'Вступай',
    whenRu: '«Вступать» и цель для фокуса',
    tier: 'urgent',
    cooldownMs: 10_000,
    // упругая квинта вверх
    notes: motif('urgent', [[N.C5, 0, 90], [N.G5, 100, 180]]),
  },
  // ---- Советы ----
  ult: {
    nameRu: 'Ульта готова',
    whenRu: 'ульта снова готова после перезарядки или только что изучена',
    tier: 'advice',
    cooldownMs: 20_000,
    // яркий «динь»: квинта вверх
    notes: motif('advice', [[N.G5, 0, 100], [N.D6, 80, 220, 1.2]]),
  },
  focus: {
    nameRu: 'Фокус матча',
    whenRu: 'выбран фокус на матч и подсказки, которые к нему относятся',
    tier: 'advice',
    cooldownMs: 20_000,
    // «колокольчик»: квинта вверх ре — ля, вторая нота длиннее
    notes: motif('advice', [[N.D5, 0, 110], [N.A5, 100, 200, 1.1]]),
  },
  item: {
    nameRu: 'Хватает на предмет',
    whenRu: 'золота хватает на следующий предмет сборки',
    tier: 'advice',
    cooldownMs: 60_000,
    // тёплый аккорд до-мажор с разбегом
    notes: motif('advice', [[N.C5, 0, 300], [N.E5, 30, 270, 0.8], [N.G5, 60, 240, 0.7]]),
  },
  buy: {
    nameRu: 'Купить нужное',
    whenRu: 'нет TP, регена или вардов',
    tier: 'advice',
    cooldownMs: 120_000,
    // кварта вверх
    notes: motif('advice', [[N.E5, 0, 110], [N.A5, 120, 160]]),
  },
  skill: {
    nameRu: 'Очко навыка',
    whenRu: 'есть неиспользованное очко навыка, шестой уровень',
    tier: 'advice',
    // напоминание повторяется, пока очко не потрачено, — звук не чаще раза в 2 мин
    cooldownMs: 120_000,
    // короткое арпеджио вверх
    notes: motif('advice', [[N.G4, 0, 80], [N.C5, 80, 80], [N.E5, 160, 140]]),
  },
  regen: {
    nameRu: 'Реген и мана',
    whenRu: 'используйте реген, ману, бутылку',
    tier: 'advice',
    cooldownMs: 45_000,
    // квинта вверх и обратно
    notes: motif('advice', [[N.A4, 0, 100], [N.E5, 110, 100], [N.A4, 220, 80, 0.7]]),
  },
  farm: {
    nameRu: 'Иди фармить',
    whenRu: 'простой без дела, маршрут фарма',
    tier: 'advice',
    cooldownMs: 120_000,
    // двойной лёгкий стук на одной ноте
    notes: motif('advice', [[N.A4, 0, 70], [N.A4, 120, 110, 0.85]]),
  },
  team: {
    nameRu: 'Команда',
    whenRu: 'пуш, помощь союзникам, сбор команды',
    tier: 'advice',
    cooldownMs: 30_000,
    // «зов»: квинта и кварта вверх
    notes: motif('advice', [[N.G4, 0, 90], [N.D5, 95, 90], [N.G5, 190, 120]]),
  },
  buyback: {
    nameRu: 'Выкуп',
    whenRu: 'на выкуп не хватает, держите золото на выкуп',
    tier: 'advice',
    cooldownMs: 60_000,
    // «монетка»: высокая терция вниз и обратно
    notes: motif('advice', [[N.E6, 0, 60, 0.85], [N.C6, 70, 60, 0.85], [N.E6, 140, 120, 0.85]]),
  },
  building: {
    nameRu: 'Бьют здание',
    whenRu: 'враги ломают вашу башню или здание',
    tier: 'advice',
    cooldownMs: 30_000,
    // кварта вверх и вниз
    notes: motif('advice', [[N.B4, 0, 90], [N.E5, 100, 90], [N.B4, 200, 100]]),
  },
  aegis: {
    nameRu: 'Аегис пропадает',
    whenRu: 'аегис скоро исчезнет',
    tier: 'advice',
    cooldownMs: 30_000,
    // кварта вниз высоко
    notes: motif('advice', [[N.C6, 0, 110, 0.8], [N.G5, 120, 170]]),
  },
  review: {
    nameRu: 'Разбор готов',
    whenRu: 'готов разбор смерти или матча',
    tier: 'advice',
    cooldownMs: 10_000,
    // спокойная кварта вверх
    notes: motif('advice', [[N.G4, 0, 160, 1.15], [N.C5, 170, 130]]),
  },
  // ---- Фоновые ----
  rune: {
    nameRu: 'Скоро руна',
    whenRu: 'скоро руна (сила, богатство, вода) или лотос',
    tier: 'background',
    cooldownMs: 60_000,
    // тихий «блеск»: три коротких высоких ноты
    notes: motif('background', [[N.E6, 0, 70, 0.9], [N.G6, 60, 70, 0.8], [N.C7, 120, 140, 0.6]]),
  },
  timing: {
    nameRu: 'Тайминг',
    whenRu: 'стак, Рошан, Мучитель, смена суток, святилище, нейтральные предметы',
    tier: 'background',
    cooldownMs: 20_000,
    // мягкий низкий «ток»
    notes: motif('background', [[N.A3, 0, 150, 1.3], [N.A5, 0, 60, 0.3]]),
  },
  shop: {
    nameRu: 'Совет по предметам',
    whenRu: 'что купить дальше, что продать, нейтральный слот, предметы врага',
    tier: 'background',
    cooldownMs: 45_000,
    // одна мягкая нота с квинтой
    notes: motif('background', [[N.E4, 0, 200, 1], [N.B4, 0, 200, 0.45]]),
  },
  map: {
    nameRu: 'Карта и враги',
    whenRu: "аванпост, Blink и Linken's у врага, шестой уровень врага, план на карте",
    tier: 'background',
    cooldownMs: 45_000,
    // кварта вниз, тихо
    notes: motif('background', [[N.A4, 0, 140, 1.2], [N.E4, 150, 160, 1.2]]),
  },
};

/** Чем выше, тем важнее: из нескольких сигналов сразу звучит важнейший; внутри уровня — по порядку в каталоге */
export function cuePriority(id: SoundCueId): number {
  const base = { urgent: 300, advice: 200, background: 100 }[SOUND_CUES[id].tier];
  return base - SOUND_CUE_IDS.indexOf(id);
}

/** Звучит и в драке: только срочные (остальные в драке молчат) */
export const cueInFight = (id: SoundCueId): boolean => SOUND_CUES[id].tier === 'urgent';

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

/** Правило подсказки → сигнал */
const RULE_CUE: Record<string, SoundCueId> = {
  'danger.missing': 'danger',
  'danger.ganker': 'danger',
  'danger.smoke': 'danger',
  'danger.invis': 'danger',
  'danger.deep': 'danger',
  'danger.low-hp': 'retreat',
  'danger.model': 'retreat',
  'fight.disengage': 'retreat',
  'fight.engage': 'engage',
  'fight.target': 'engage',
  'fight.ult-ready': 'ult',
  // Фокус матча: объявление и подсказки по фокусу (service подставляет ruleId focus.hint)
  'focus.announce': 'focus',
  'focus.hint': 'focus',
  'economy.tp': 'buy',
  'economy.wards': 'buy',
  'laning.buy-regen': 'buy',
  'economy.skill': 'skill',
  'laning.level6': 'skill',
  'laning.use-regen': 'regen',
  'laning.use-mana': 'regen',
  'laning.bottle': 'regen',
  'economy.idle': 'farm',
  'economy.route': 'farm',
  'macro.push': 'team',
  'macro.help': 'team',
  'macro.group': 'team',
  'economy.buyback': 'buyback',
  'fight.no-buyback': 'buyback',
  'fight.keep-buyback': 'buyback',
  'danger.building': 'building',
  'timing.aegis-end': 'aegis',
  'review.death': 'review',
  'review.match': 'review',
  'timing.lotus': 'rune',
  'timing.stack': 'timing',
  'timing.roshan-respawn': 'timing',
  'timing.tormentor': 'timing',
  'timing.day-night': 'timing',
  'timing.shrine-of-wisdom': 'timing',
  'timing.neutral-tier': 'timing',
  'macro.roshan-killed': 'timing',
  'economy.next': 'shop',
  'economy.sell': 'shop',
  'economy.neutral': 'shop',
  'economy.late': 'shop',
  'economy.gpm': 'shop',
  'economy.enemy-item': 'shop',
  'timing.enemy-item': 'shop',
  'laning.bench': 'shop',
  'laning.cs': 'shop',
  'draft.item': 'shop',
  'draft.overview': 'shop',
  'macro.outpost': 'map',
  'macro.personal': 'map',
  'macro.ask-position': 'map',
  'macro.blink-watch': 'map',
  'macro.enemy-blink': 'map',
  'macro.enemy-linken': 'map',
  'danger.roshan': 'map',
  'fight.matchup': 'map',
  'fight.no-ult': 'map',
  'laning.enemy6': 'map',
};

/** Какой сигнал у подсказки; null — подсказка без звука */
export function cueForHint(h: { id?: string; ruleId: string; category: string; priority: string; icon?: string | null }): SoundCueId | null {
  const r = h.ruleId;
  if (r === 'economy.gold') return typeof h.icon === 'string' && h.icon.startsWith('item:') ? 'item' : 'shop';
  if (r.startsWith('timing.rune-')) return 'rune';
  // План «драка / фарм / пуш / отход» и совет ИИ: уверенный отход — «Отходи», остальное — фоном
  if (r === 'fight.action' || r === 'ai.advice') return h.priority !== 'info' && (r === 'ai.advice' || h.id === 'fight.action:retreat') ? 'retreat' : 'map';
  return RULE_CUE[r] ?? null;
}

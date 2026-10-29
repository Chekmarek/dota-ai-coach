// Фильтр внимания: подсказка генератора → короткая подача. short (≤ 3 слов, повелительно), reason (один факт
// с числом), voice (≤ 5 слов, только срочные), details (полный текст). Детерминированно и только из данных самой
// подсказки (её текста и фактов): фильтр ничего не придумывает. Чистое ядро.
import type { HintDraft } from '../coach/types.ts';
import type { GateHint, GatePriority } from './types.ts';

/** Названия предметов и героев по ключу (из базы знаний); нет — короткая фраза без названия */
export interface GateNames {
  item?(key: string): string | null;
  hero?(key: string): string | null;
}

export const toGatePriority = (p: HintDraft['priority']): GatePriority => (p === 'critical' ? 'critical' : p === 'advice' ? 'useful' : 'info');
export const fromGatePriority = (p: GatePriority): HintDraft['priority'] => (p === 'critical' ? 'critical' : p === 'useful' ? 'advice' : 'info');

/** Тип подсказки: ruleId, а у подсказок без ruleId — id до двоеточия */
export const typeOf = (d: Pick<HintDraft, 'ruleId' | 'id'>): string => d.ruleId || d.id.split(':')[0]!;

function iconName(d: HintDraft, names: GateNames): string | null {
  const icon = d.icon ?? '';
  if (icon.startsWith('item:')) return names.item?.(icon.slice(5)) ?? null;
  if (icon.startsWith('hero:')) return names.hero?.(icon.slice(5)) ?? null;
  return null;
}

/** «Купи X» — с названием предмета, если оно известно */
const withName = (verb: string, name: string | null, fallback: string) => (name ? `${verb} ${name}` : fallback);

type ShortFn = (d: HintDraft, name: string | null) => string;

/** Короткая фраза по типу подсказки: действие, а не описание. Название предмета/героя считается одним словом */
const SHORT_BY_TYPE: Record<string, string | ShortFn> = {
  // Опасность
  'danger.missing': 'Враги пропали',
  'danger.ganker': 'Берегись ганка',
  'danger.smoke': 'Берегись смока',
  'danger.deep': 'Уходи из леса',
  'danger.low-hp': 'Отходи на базу',
  'danger.model': 'Отходи',
  'danger.building': 'Защити здание',
  'danger.roshan': 'Проверь Рошана',
  'danger.invis': 'Купи пыль',
  // Драка
  'fight.engage': (d) => (/^Не вступать/.test(d.short) ? 'Не вступай' : /^Вступать/.test(d.short) ? 'Вступай' : 'Драка на равных'),
  'fight.disengage': 'Отходи',
  'fight.target': (_d, name) => withName('Бей', name, 'Добей слабого'),
  'fight.action': (d) => {
    const a = d.facts.find((f) => f.key === 'action')?.value;
    return a === 'fight' ? 'Дерись' : a === 'farm' ? 'Фарми' : a === 'push' ? 'Пушь' : a === 'retreat' ? 'Отходи' : 'Смени план';
  },
  'fight.no-ult': 'Жди ульту',
  'fight.ult-ready': 'Ульта готова',
  'fight.matchup': (_d, name) => withName('Размен с', name, 'Размен 1×1'),
  'fight.keep-buyback': 'Береги выкуп',
  'fight.no-buyback': 'Нет выкупа',
  // Экономика
  'economy.next': (_d, name) => withName('Купи', name, 'Следующий предмет'),
  'economy.gold': (_d, name) => withName('Купи', name, 'Потрать золото'),
  'economy.buyback': 'Копи на выкуп',
  'economy.late': (_d, name) => withName('Ускорь', name, 'Предмет запаздывает'),
  'economy.sell': 'Продай лишнее',
  'economy.skill': 'Вкачай навык',
  'economy.tp': 'Купи TP',
  'economy.wards': 'Купи варды',
  'economy.neutral': 'Возьми нейтралку',
  'economy.idle': 'Иди фармить',
  'economy.gpm': 'Фарми больше',
  'economy.route': 'Фарми по кругу',
  'economy.enemy-item': (_d, name) => withName('Купи', name, 'Ответ на предмет'),
  // Линия
  'laning.use-regen': 'Подлечись',
  'laning.buy-regen': 'Купи реген',
  'laning.use-mana': 'Восстанови ману',
  'laning.bottle': 'Наполни бутылку',
  'laning.level6': 'Ищи убийство',
  'laning.enemy6': 'Бойся ульты',
  'laning.cs': 'Добивай крипов',
  'laning.bench': (d) => (/^Отличный/.test(d.short) ? 'Отличный фарм' : 'Добивай больше'),
  // Макро
  'macro.push': 'Пушь башню',
  'macro.group': 'Иди к команде',
  'macro.help': (d) => (/телепорт/.test(d.short) ? 'Телепорт к бою' : 'Помоги команде'),
  'macro.pickoff': (d) => `Охота на ${d.short.split(' один')[0]}`,
  'macro.outpost': 'Возьми аванпост',
  'macro.roshan-killed': 'Рошан убит',
  'macro.personal': 'Помни ошибку',
  'macro.ask-position': 'Выбери позицию',
  'macro.enemy-blink': 'Не стой кучей',
  'macro.blink-watch': 'Следи за прыжком',
  'macro.enemy-linken': 'Сбей Linken',
  // Тайминги
  'timing.rune-power': 'К руне силы',
  'timing.rune-bounty': 'К руне богатства',
  'timing.rune-water': 'К руне воды',
  'timing.lotus': 'Забери лотос',
  'timing.stack': 'Стакни лагерь',
  'timing.neutral-tier': 'Новые нейтралки',
  'timing.aegis-end': 'Аегис кончается',
  'timing.enemy-item': 'Предмет врага',
  'timing.day-night': (d) => (/ноч/i.test(d.short) ? 'Скоро ночь' : 'Скоро день'),
  'timing.tormentor': 'Мучитель скоро',
  'timing.roshan-respawn': 'Рошан скоро',
  'timing.shrine-of-wisdom': 'К святилищу',
  // Драфт
  'draft.overview': 'План на матч',
  'draft.item': (_d, name) => withName('Купи', name, 'Предмет против врагов'),
  // ИИ: «Отходить: к своей башне» → «Отходи»
  'ai.advice': (d) => {
    const a = d.short.split(':')[0]!.trim();
    return ({ Отходить: 'Отходи', Драться: 'Дерись', Фармить: 'Фарми', Пушить: 'Пушь' } as Record<string, string>)[a] ?? firstWords(a, 3);
  },
};

/** Голос — только срочным: короткие фразы одного набора (для заранее записанных клипов) */
const VOICE_BY_TYPE: Record<string, string | ((d: HintDraft) => string | null)> = {
  'danger.missing': 'Осторожно, враги пропали',
  'danger.ganker': 'Осторожно, ганк',
  'danger.smoke': 'Осторожно, смок',
  'danger.deep': 'Уходи из леса',
  'danger.low-hp': 'Отходи на базу',
  'danger.model': 'Отходи',
  'danger.building': 'Защити здание',
  'danger.invis': 'Невидимка, купи пыль',
  'fight.disengage': 'Отходи',
  'fight.engage': (d) => (/^Не вступать/.test(d.short) ? 'Не вступай' : /^Вступать/.test(d.short) ? 'Вступай' : null),
  'fight.target': 'Бей слабого',
};

function firstWords(s: string, n: number): string {
  return s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');
}

/**
 * Слова короткой фразы: названия (предмета, героя) считаются одним словом — «Купи Black King Bar» — это 2 слова.
 */
export function shortWordCount(s: string, protectedNames: readonly string[] = []): number {
  let t = s;
  for (const n of protectedNames) if (n) t = t.split(n).join('Ⓝ');
  return t.split(/\s+/).filter((w) => /[\p{L}\p{N}Ⓝ]/u.test(w)).length;
}

export function deriveShort(d: HintDraft, names: GateNames = {}): { short: string; name: string | null } {
  const name = iconName(d, names);
  if (d.gate?.short) return { short: d.gate.short, name };
  const t = SHORT_BY_TYPE[typeOf(d)];
  if (typeof t === 'string') return { short: t, name: null };
  if (t) return { short: t(d, name), name };
  // Остальное: часть до «:» или «—» (там действие или тема), не больше 3 слов
  const head = d.short.split(/\s*[:—·]\s*/)[0]!.trim();
  return { short: firstWords(head || d.short, 3), name: null };
}

const NUM = /\d/;

/** Значение факта строкой: «Здоровье, %» + 29 → «Здоровье 29%» */
function factText(label: string, value: string | number | boolean): string {
  const pct = /,\s*%$/.test(label);
  const l = label.replace(/,\s*%$/, '').replace(/,\s*с$/, '').trim();
  const sec = /,\s*с$/.test(label);
  return `${l} ${value}${pct ? '%' : sec ? ' с' : ''}`;
}

/**
 * Причина — один конкретный факт с числом. Сначала из текста подсказки (часть после «:», «—» или «·» с числом),
 * затем из её фактов (первое число, кроме игрового времени). Нет числа — null: лучше без причины, чем выдумка.
 */
export function deriveReason(d: HintDraft, short: string): string | null {
  if (d.gate && d.gate.reason !== undefined) return d.gate.reason;
  // Части фразы по «:», «—», «·»; двоеточие времени («Стак в :54») — не разделитель
  const parts = d.short.split(/\s*(?::(?!\d)|—|·)\s*/).map((s) => s.trim()).filter(Boolean);
  // Из части — первый кусок до запятой с числом: «Руна воды через 15 с, бежать 20 с» → «Руна воды через 15 с»
  const piece = (p: string) => (p.split(/,\s*/).find((x) => NUM.test(x)) ?? p).replace(/[.;]$/, '');
  // Первая часть с числом: «GPM 300 — ниже обычного 526» → «GPM 300»; «Не вступать: шанс 34%» → «шанс 34%»
  for (const p of parts) if (NUM.test(p) && p !== short) return piece(p);
  // Факты матча (игра, экран, вывод коуча); справочные (цена, «обычно к минуте») — не причина «почему сейчас»
  for (const f of d.facts) {
    if (f.key === 'clock' || f.value === null || typeof f.value === 'boolean' || f.source === 'kb' || f.source === 'stats') continue;
    if (typeof f.value === 'number' || NUM.test(f.value)) return factText(f.label, typeof f.value === 'number' ? Math.round(f.value * 10) / 10 : f.value);
  }
  return null;
}

export function deriveVoice(d: HintDraft, priority: GatePriority): string | null {
  if (priority !== 'critical') return null;
  if (d.gate && d.gate.voice !== undefined) return d.gate.voice;
  const v = VOICE_BY_TYPE[typeOf(d)];
  if (typeof v === 'function') return v(d);
  return v ?? null;
}

export interface ToGateOptions {
  nowMs: number;
  names?: GateNames;
  /** Тип понижен до info после «не нужно» в нескольких матчах */
  demoted?: boolean;
  /** Подсказка по фокусу матча: info → useful («не нужно» сильнее фокуса) */
  focus?: boolean;
}

export function toGateHint(d: HintDraft, o: ToGateOptions): GateHint {
  const base = toGatePriority(d.priority);
  const priority: GatePriority = o.demoted ? 'info' : o.focus && base === 'info' ? 'useful' : base;
  const { short } = deriveShort(d, o.names);
  return {
    key: `${d.id}|${short}`,
    id: d.id,
    type: typeOf(d),
    category: d.category,
    priority,
    confidence: d.confidence,
    short,
    voice: deriveVoice(d, priority),
    reason: deriveReason(d, short),
    details: d.detail.normal,
    expiresAt: o.nowMs + d.ttlMs,
    zone: d.zone ?? (priority === 'critical' ? 'alert' : d.category === 'timing' || d.category === 'economy' ? 'timing' : 'decision'),
    icon: d.icon ?? null,
    repeating: d.cooldownMs > 0,
    focus: o.focus === true && !o.demoted,
    source: d,
  };
}

/** Ключ предмета в подсказке (иконка item:…) — для проверки «уже куплено» */
export function itemKeyOf(h: Pick<GateHint, 'icon' | 'type'>): string | null {
  if (!h.icon?.startsWith('item:')) return null;
  // Иконка у «Против врагов» и «Предмет врага» — предмет врага, а не совет купить
  if (h.type === 'timing.enemy-item' || h.type === 'macro.enemy-blink' || h.type === 'macro.blink-watch' || h.type === 'macro.enemy-linken') return null;
  return h.icon.slice(5);
}

/** Куда зовёт подсказка: назад (отход) — для проверки, выполнил ли игрок совет */
export function isRetreat(h: Pick<GateHint, 'short'>): boolean {
  return /^(Отходи|Уходи|Не вступай)/.test(h.short);
}

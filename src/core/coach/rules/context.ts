// Общее для правил: контекст тика и помощники для подсказок.
import type { CoachView } from '../view.ts';
import type { CoachMemory, MemoryEvents } from '../memory.ts';
import type { CoachLookup } from '../data.ts';
import type { CoachSettings, FactRef, HintCategory, HintDraft, HintPriority } from '../types.ts';
import { MAP_ZONE_RU, type MapZone } from '../../match-state/map-zones.ts';
import { buildGameContext, type GameContext } from '../game-context.ts';
import { buildMatchKnowledge, knowledgeSig, type MatchKnowledge } from '../knowledge.ts';

export interface RuleContext {
  v: CoachView;
  mem: CoachMemory;
  ev: MemoryEvents;
  look: CoachLookup;
  settings: CoachSettings;
  /** wallMs снимка */
  now: number;
  /** Контекст игры (стадия, позиция, герой) — движок считает раз за тик; читать через game(c) */
  g?: GameContext;
  /** Знания на матч (кэш движка, пересобирается при смене состава); читать через knowledge(c) */
  k?: MatchKnowledge;
  /** На экране «назад» или «Высокий риск смерти» (движок, по очереди подсказок): плановые покупки ждут */
  highRisk?: boolean;
  /** На экране «Вступать» (движок, по очереди подсказок) */
  engageGo?: boolean;
}

/**
 * Совет о плановой покупке сейчас не покажут (драка или высокий риск смерти — арбитр его отложит): разовые правила
 * («запаздывает», ответ на предмет врага) ждут и не тратят свой единственный показ.
 */
export const purchaseWait = (c: RuleContext): boolean => c.mem.inFight || c.highRisk === true;

/** Контекст игры тика: посчитан движком или (в тестах отдельных правил) — здесь, один раз */
export function game(c: RuleContext): GameContext {
  c.g ??= buildGameContext(c.v, c.mem, c.look, c.settings.position ?? 'auto');
  return c.g;
}

/** Знания на матч: от движка (кэш на матч) или собранные здесь (тесты отдельных правил) */
export function knowledge(c: RuleContext): MatchKnowledge {
  const g = game(c);
  const sig = knowledgeSig(c.v, g);
  if (!c.k || c.k.sig !== sig) c.k = buildMatchKnowledge(c.v, g, c.look);
  return c.k;
}

export type Rule = (c: RuleContext) => HintDraft | HintDraft[] | null;

export interface DraftInput {
  id: string;
  ruleId?: string;
  category: HintCategory;
  priority: HintPriority;
  confidence: number;
  short: string;
  normal: string;
  /** Подробный текст; по умолчанию — обычный + факты */
  detailed?: string;
  facts: FactRef[];
  ttlSec: number;
  cooldownSec: number;
  percent?: HintDraft['percent'];
  zone?: HintDraft['zone'];
  icon?: string | null;
}

const SOURCE_RU: Record<FactRef['source'], string> = { gsi: 'игра', screen: 'экран', derived: 'вывод', kb: 'база', stats: 'статистика патча' };

/** «Здоровье 28% (игра, 0 с)» — строка факта для подробного режима */
export function factLine(f: FactRef): string {
  const v = f.value === null ? 'нет данных' : typeof f.value === 'boolean' ? (f.value ? 'да' : 'нет') : String(f.value);
  const age = f.ageSec === null ? '' : `, ${Math.round(f.ageSec)} с`;
  return `${f.label}: ${v} (${SOURCE_RU[f.source]}${age}${f.verified ? '' : ', не проверено'})`;
}

export function draft(d: DraftInput): HintDraft {
  const detailed = d.detailed ?? [d.normal, ...d.facts.filter((f) => f.value !== null).slice(0, 4).map(factLine)].join(' · ');
  return {
    id: d.id,
    ruleId: d.ruleId ?? d.id.split(':')[0]!,
    category: d.category,
    priority: d.priority,
    confidence: Math.max(0, Math.min(1, d.confidence)),
    short: d.short,
    detail: { normal: d.normal, detailed },
    percent: d.percent ?? null,
    facts: d.facts,
    ttlMs: d.ttlSec * 1000,
    cooldownMs: d.cooldownSec * 1000,
    zone: d.zone,
    icon: d.icon ?? null,
  };
}

export const zoneRu = (z: MapZone | null): string => (z ? MAP_ZONE_RU[z] : 'неизвестно где');

/** Минимальная уверенность из набора фактов */
export const minConf = (facts: readonly FactRef[]): number => (facts.length ? Math.min(...facts.map((f) => f.confidence)) : 0);

export function mmss(sec: number): string {
  const s = Math.round(sec);
  const a = Math.abs(s);
  return `${s < 0 ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

/** Склонение: 1 враг, 2 врага, 5 врагов */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Герой жив, матч идёт, не пауза */
export const playing = (c: RuleContext): boolean => c.v.inGame && !c.v.paused && c.v.me.alive.value === true;

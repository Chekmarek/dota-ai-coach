// Подсказка движка → карточка окна поверх игры (HudHint): текст по выбранной подробности, факторы % — только
// в режиме «Подробно», разборы — отдельной панелью. С фильтром внимания — короткая подача (gateToHudHint). Чистое ядро.
import type { HudHint } from '../../shared/types/hud.ts';
import { hintText, type DetailLevel, type Hint } from './types.ts';
import type { DeathReview, MatchReview } from './reviews.ts';
import { mmss } from './rules/context.ts';
import { fromGatePriority } from '../gate/derive.ts';
import type { GateVisible } from '../gate/types.ts';

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Совет, а не пересказ фактов: в предложении есть призыв («нажимайте», «не заходите», «лучше…») */
const ADVICE_RE = /(^|\s)(не\s+\p{L}+|лучше|стоит|нужно|надо|следите|следовало|старайтесь)|\p{L}{2,}(йте|ите|ьте)(?=[\s,.!;:]|$)/iu;
const words = (s: string) => new Set(s.toLowerCase().match(/\p{L}{4,}/gu) ?? []);

/**
 * Текст ИИ к разбору смерти — только полезное: предложения с советом, которые не повторяют совет шаблона.
 * Пересказ фактов («— Смерть произошла в 2:07. — Врагов рядом при смерти: 0.») выбрасывается; ничего не осталось — null.
 */
export function usefulAiText(text: string | null, already: readonly string[]): string | null {
  if (!text) return null;
  const known = already.map(words);
  const sentences = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.replace(/^[\s—–\-•*]+/, '').trim())
    .filter(Boolean);
  const keep = sentences.filter((s) => {
    if (!ADVICE_RE.test(s)) return false;
    const w = words(s);
    if (!w.size) return false;
    // почти то же, что совет шаблона, — не нужно
    return !known.some((k) => [...w].filter((x) => k.has(x)).length / w.size >= 0.6);
  });
  return keep.length ? keep.slice(0, 2).join(' ') : null;
}

/** Разбор смерти — сжато (решение владельца 2026-10-24): главная причина, один совет, выкуп — только если есть что делать */
function deathPanel(r: DeathReview): NonNullable<HudHint['review']> {
  const ai = usefulAiText(r.aiText, [...r.why, ...r.tips]);
  return {
    kind: 'death',
    heading: cut(`Разбор смерти${r.clock !== null ? ` · ${mmss(r.clock)}` : ''}`, 80),
    why: r.why.slice(0, 1).map((x) => cut(x, 140)),
    tips: r.tips.slice(0, 1).map((x) => cut(x, 140)),
    footer: r.buyback.advice === 'buy' || r.buyback.advice === 'save' ? cut(r.buyback.text, 140) : null,
    stats: [],
    aiText: ai ? cut(ai, 300) : null,
  };
}

type FocusBlock = NonNullable<NonNullable<HudHint['review']>['focus']>;
type XpBlock = NonNullable<NonNullable<HudHint['review']>['xp']>;

function matchPanel(r: MatchReview, deferred: readonly { short: string; count: number }[] = [], focus: FocusBlock | null = null, focusOnly = false, xp: XpBlock | null = null): NonNullable<HudHint['review']> {
  // Первые 10 с после матча — только итог фокуса (крупно) и опыт, потом обычный разбор под ними
  if ((focus || xp) && focusOnly) {
    const head = r.result === 'win' ? 'Победа' : r.result === 'loss' ? 'Поражение' : 'Матч окончен';
    return { kind: 'match', heading: cut(head, 80), why: [], tips: [], footer: null, stats: [], aiText: null, focus, focusOnly: true, xp };
  }
  const head = [r.result === 'win' ? 'Победа' : r.result === 'loss' ? 'Поражение' : 'Матч окончен', r.durationSec !== null ? mmss(r.durationSec) : null, r.heroName].filter(Boolean).join(' · ');
  // Советы с низкой уверенностью в игре не показывались (фильтр внимания) — здесь, одной строкой
  const later = deferred.length ? [`Не показали в игре (коуч не был уверен): ${deferred.slice(0, 3).map((d) => (d.count > 1 ? `${d.short} ×${d.count}` : d.short)).join(', ')}`] : [];
  return {
    kind: 'match',
    heading: cut(head, 80),
    why: [...r.why.filter((w) => w !== 'Победа' && w !== 'Поражение'), ...r.goodPlays.map((g) => `Хорошо: ${g}`)].slice(0, 6 - later.length).concat(later).map((x) => cut(x, 200)),
    tips: r.goals.slice(0, 4).map((x) => cut(x, 200)),
    footer: r.topMistakes.length ? cut(`Ошибки: ${r.topMistakes.map((m) => (m.clock !== null ? `${mmss(m.clock)} ${m.text}` : m.text)).join('; ')}`, 200) : null,
    stats: r.stats.slice(0, 10).map((s) => ({ label: cut(s.label, 60), value: s.value === null ? '—' : cut(String(s.value), 30), ref: s.ref === null ? null : cut(String(s.ref), 30), verdict: s.verdict })),
    aiText: r.aiText ? cut(r.aiText.replace(/\n+/g, ' '), 1500) : null,
    ...(focus || xp ? { focus, focusOnly: false, xp } : {}),
  };
}

export function toHudHint(
  h: Hint,
  detail: DetailLevel,
  reviews: { death: DeathReview | null; match: MatchReview | null; deferred?: readonly { short: string; count: number }[]; focus?: FocusBlock | null; focusOnly?: boolean; xp?: XpBlock | null },
): HudHint {
  const p = h.percent?.estimate;
  let review: HudHint['review'] = null;
  if (h.ruleId === 'review.death' && reviews.death) review = deathPanel(reviews.death);
  if (h.ruleId === 'review.match' && reviews.match) review = matchPanel(reviews.match, reviews.deferred, reviews.focus ?? null, reviews.focusOnly ?? false, reviews.xp ?? null);
  return {
    seq: h.seq,
    zone: h.zone,
    priority: h.priority,
    category: h.category,
    title: cut(h.short, 120),
    text: cut(hintText(h, detail) === h.short ? '' : hintText(h, detail), 600),
    percent:
      p && h.percent
        ? {
            label: cut(h.percent.label, 40),
            value: p.value,
            confidence: p.confidence,
            factors:
              detail === 'detailed'
                ? p.factors
                    .filter((f) => f.known && Math.abs(f.effect) >= 1)
                    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
                    .slice(0, 6)
                    .map((f) => ({ label: cut(f.label, 60), effect: Math.max(-100, Math.min(100, Math.round(f.effect))) }))
                : [],
          }
        : null,
    icon: h.icon ? cut(h.icon, 80) : null,
    source: h.textSource,
    ttlMs: Math.max(0, Math.min(3_600_000, Math.round(h.expiresWallMs - h.createdWallMs))),
    review,
  };
}

/**
 * Подсказка после фильтра внимания → карточка: заголовок — короткая фраза (≤ 3 слов), строка — одна причина с числом.
 * Подробности — только в спокойный момент (мёртв, на базе, пауза) или в режиме «Подробно»; «Минимум» — без строки.
 * Процент — только в режиме «Подробно»: в игре хватает причины.
 */
export function gateToHudHint(v: GateVisible, detail: DetailLevel): HudHint {
  const h = v.hint;
  const src = h.source;
  const reason = h.reason ?? '';
  const full = v.withDetails || detail === 'detailed';
  // Подробности уже содержат причину — только они, без повтора
  const withDetails = reason && h.details.includes(reason) ? h.details : [reason, h.details].filter(Boolean).join(' · ');
  const text = detail === 'min' ? '' : full && h.details && h.details !== h.short ? withDetails : reason;
  const p = src.percent?.estimate;
  return {
    seq: v.seq,
    zone: h.zone,
    priority: fromGatePriority(h.priority),
    category: h.category,
    title: cut(h.short, 120),
    text: cut(text, 600),
    percent:
      detail === 'detailed' && p && src.percent
        ? {
            label: cut(src.percent.label, 40),
            value: p.value,
            confidence: p.confidence,
            factors: p.factors
              .filter((f) => f.known && Math.abs(f.effect) >= 1)
              .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
              .slice(0, 6)
              .map((f) => ({ label: cut(f.label, 60), effect: Math.max(-100, Math.min(100, Math.round(f.effect))) })),
          }
        : null,
    icon: h.icon ? cut(h.icon, 80) : null,
    source: h.type === 'ai.advice' ? 'ai' : 'template',
    ttlMs: Math.max(0, Math.min(3_600_000, Math.round(v.untilMs - v.shownMs))),
    review: null,
  };
}

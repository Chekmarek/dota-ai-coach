// Подсказка движка → карточка окна поверх игры (HudHint): текст по выбранной подробности, факторы % — только
// в режиме «Подробно», разборы — отдельной панелью. Чистое ядро.
import type { HudHint } from '../../shared/types/hud.ts';
import { hintText, type DetailLevel, type Hint } from './types.ts';
import type { DeathReview, MatchReview } from './reviews.ts';
import { mmss } from './rules/context.ts';

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function deathPanel(r: DeathReview): NonNullable<HudHint['review']> {
  return {
    kind: 'death',
    heading: cut(`Разбор смерти${r.clock !== null ? ` · ${mmss(r.clock)}` : ''}`, 80),
    why: r.why.slice(0, 6).map((x) => cut(x, 200)),
    tips: r.tips.slice(0, 4).map((x) => cut(x, 200)),
    footer: cut(r.buyback.text, 200),
    stats: [],
    aiText: r.aiText ? cut(r.aiText.replace(/\n+/g, ' '), 1500) : null,
  };
}

function matchPanel(r: MatchReview): NonNullable<HudHint['review']> {
  const head = [r.result === 'win' ? 'Победа' : r.result === 'loss' ? 'Поражение' : 'Матч окончен', r.durationSec !== null ? mmss(r.durationSec) : null, r.heroName].filter(Boolean).join(' · ');
  return {
    kind: 'match',
    heading: cut(head, 80),
    why: [...r.why.filter((w) => w !== 'Победа' && w !== 'Поражение'), ...r.goodPlays.map((g) => `Хорошо: ${g}`)].slice(0, 6).map((x) => cut(x, 200)),
    tips: r.goals.slice(0, 4).map((x) => cut(x, 200)),
    footer: r.topMistakes.length ? cut(`Ошибки: ${r.topMistakes.map((m) => (m.clock !== null ? `${mmss(m.clock)} ${m.text}` : m.text)).join('; ')}`, 200) : null,
    stats: r.stats.slice(0, 10).map((s) => ({ label: cut(s.label, 60), value: s.value === null ? '—' : cut(String(s.value), 30), ref: s.ref === null ? null : cut(String(s.ref), 30), verdict: s.verdict })),
    aiText: r.aiText ? cut(r.aiText.replace(/\n+/g, ' '), 1500) : null,
  };
}

export function toHudHint(h: Hint, detail: DetailLevel, reviews: { death: DeathReview | null; match: MatchReview | null }): HudHint {
  const p = h.percent?.estimate;
  let review: HudHint['review'] = null;
  if (h.ruleId === 'review.death' && reviews.death) review = deathPanel(reviews.death);
  if (h.ruleId === 'review.match' && reviews.match) review = matchPanel(reviews.match);
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

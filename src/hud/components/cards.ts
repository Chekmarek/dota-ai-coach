// Компоненты подсказок: HintCard, AlertBanner, DecisionCard (с %), ReviewPanel. Без React — обычный DOM:
// один и тот же код рисует оверлей поверх игры и страницу «Предпросмотр подсказок».
// Вид — только классы hud-* и CSS-переменные темы (hud.css, theme/), никаких цветов и размеров здесь.
import type { HudHint } from '../../shared/types/hud.ts';
import { h } from './dom.ts';
import { aiMark, emblem, severityIcon } from './icons.ts';

export type CardKind = 'card' | 'alert' | 'decision' | 'review';

/** Какой компонент рисует подсказку */
export function kindOf(hint: HudHint): CardKind {
  if (hint.zone === 'review' || hint.review) return 'review';
  if (hint.percent) return 'decision';
  if (hint.zone === 'alert') return 'alert';
  return 'card';
}

function head(hint: HudHint, title = hint.title): HTMLElement[] {
  return [h('div', 'hud-head', emblem(), h('span', 'hud-title', title), hint.source === 'ai' ? aiMark() : null, severityIcon(hint.priority))];
}

/** Сколько факторов процента показывать: самые сильные, чтобы карточка оставалась маленькой */
const MAX_FACTORS = 3;

/** Полоска «сколько ещё будет на экране» — CSS-анимация transform (видеокарта) */
function ttlBar(hint: HudHint): HTMLElement | null {
  if (hint.ttlMs <= 0 || hint.zone === 'review') return null;
  const i = h('i', null);
  i.style.animationDuration = `${hint.ttlMs}ms`;
  return h('div', 'hud-ttl', i);
}

/** Процент — кольцо (заполнено на value %), уверенность — тонкая полоса, ниже — самые сильные факторы */
function percentBlock(p: NonNullable<HudHint['percent']>): HTMLElement {
  const medal = h('div', 'hud-medal', h('span', 'hud-pct-num', `${Math.round(p.value)}%`));
  medal.style.setProperty('--p', String(Math.max(0, Math.min(100, p.value))));
  const fill = h('i', null);
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, p.confidence))})`;
  const top = [...p.factors].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, MAX_FACTORS);
  const factors = top.length
    ? h('ul', 'hud-factors', ...top.map((f) => h('li', f.effect >= 0 ? 'hud-f-plus' : 'hud-f-minus', h('span', null, f.label), h('b', null, `${f.effect > 0 ? '+' : ''}${Math.round(f.effect)}`))))
    : null;
  const side = h('div', 'hud-pct-side', h('span', 'hud-pct-label', p.label), h('span', 'hud-conf', `уверенность ${Math.round(p.confidence * 100)}%`), h('div', 'hud-bar', fill));
  return h('div', 'hud-pctbox', h('div', 'hud-pct', medal, side), factors);
}

function reviewBody(r: NonNullable<HudHint['review']>): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (r.aiText) out.push(h('p', 'hud-review-ai', aiMark(), r.aiText));
  if (r.why.length) out.push(h('div', 'hud-review-sec', h('h4', null, r.kind === 'death' ? 'Почему' : 'Итог'), h('ul', null, ...r.why.map((w) => h('li', null, w)))));
  if (r.stats.length)
    out.push(
      h(
        'table',
        'hud-stats',
        ...r.stats.map((s) => h('tr', s.verdict ? `hud-v-${s.verdict}` : null, h('td', null, s.label), h('td', 'hud-stat-v', s.value), h('td', 'hud-stat-ref', s.ref ?? ''))),
      ),
    );
  if (r.tips.length) out.push(h('div', 'hud-review-sec', h('h4', null, r.kind === 'death' ? 'Что сделать иначе' : 'Цели на следующую игру'), h('ol', null, ...r.tips.map((t) => h('li', null, t)))));
  if (r.footer) out.push(h('div', 'hud-review-foot', r.footer));
  return out;
}

/** Внутренность карточки (без корня — его сохраняем при обновлении текста ради анимаций) */
export function cardContent(hint: HudHint): Element[] {
  const kind = kindOf(hint);
  const body = h('div', 'hud-body');
  if (kind === 'review' && hint.review) {
    body.append(...head(hint, hint.review.heading || hint.title), ...reviewBody(hint.review));
  } else {
    body.append(...head(hint));
    if (hint.text) body.append(h('div', 'hud-text', hint.text));
    if (kind === 'decision' && hint.percent) body.append(percentBlock(hint.percent));
    const ttl = ttlBar(hint);
    if (ttl) body.append(ttl);
  }
  return [h('div', 'hud-glow', null), h('div', 'hud-frame', body)];
}

/** Корень карточки: вид зависит от важности и типа */
export function renderHint(hint: HudHint): HTMLElement {
  const root = h('div', `hud-card hud-k-${kindOf(hint)} hud-p-${hint.priority} hud-cat-${hint.category}`);
  root.dataset['seq'] = String(hint.seq);
  root.append(...cardContent(hint));
  return root;
}

/** Ключ содержимого: поменялся — перерисовать внутренность */
export function contentKey(hint: HudHint): string {
  return JSON.stringify([hint.title, hint.text, hint.percent, hint.review, hint.source, hint.priority]);
}

// Компоненты подсказок: HintCard, AlertBanner, DecisionCard (с %), ReviewPanel. Без React — обычный DOM:
// один и тот же код рисует оверлей поверх игры и страницу «Подсказки в игре».
// Вид — только классы hud-* и CSS-переменные темы (hud.css, theme/), никаких цветов и размеров здесь.
// Иерархия плашки: действие (заголовок) → причина (≤ 2 строк) → число → подробности (только «Подробно»).
import type { HudHint } from '../../shared/types/hud.ts';
import { h } from './dom.ts';
import { aiMark, emblem, severityIcon } from './icons.ts';
import { reasonText } from '../../core/hud/text.ts';

export type CardKind = 'card' | 'alert' | 'decision' | 'review';

/** Какой компонент рисует подсказку */
export function kindOf(hint: HudHint): CardKind {
  if (hint.zone === 'review' || hint.review) return 'review';
  if (hint.percent) return 'decision';
  if (hint.zone === 'alert') return 'alert';
  return 'card';
}

function head(hint: HudHint, title = hint.title): HTMLElement[] {
  return [
    h(
      'div',
      'hud-head',
      emblem(),
      h('span', 'hud-title', title),
      hint.source === 'ai' ? aiMark() : null,
      // Срочность не только цветом: другой значок и слово
      hint.priority === 'critical' ? h('span', 'hud-tag', 'Срочно') : null,
      severityIcon(hint.priority),
    ),
  ];
}

/** Сколько факторов процента показывать: самые сильные, чтобы карточка оставалась маленькой */
const MAX_FACTORS = 3;

/** Полоса «сколько ещё будет на экране»: длительность — из --ttl корня, продлённый показ сдвигает её назад */
function ttlBar(hint: HudHint): HTMLElement | null {
  if (hint.ttlMs <= 0 || hint.zone === 'review') return null;
  return h('div', 'hud-ttl', h('i', null));
}

/** Процент — крупное число (главное), подпись, уверенность оценки — тонкой полосой; факторы — в «Подробно» */
function percentBlock(p: NonNullable<HudHint['percent']>): HTMLElement {
  const fill = h('i', null);
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, p.confidence))})`;
  const top = [...p.factors].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, MAX_FACTORS);
  const factors = top.length
    ? h('ul', 'hud-factors', ...top.map((f) => h('li', f.effect >= 0 ? 'hud-f-plus' : 'hud-f-minus', h('span', null, f.label), h('b', null, `${f.effect > 0 ? '+' : ''}${Math.round(f.effect)}`))))
    : null;
  const side = h(
    'div',
    'hud-pct-side',
    h('span', 'hud-pct-label', p.label),
    h('div', 'hud-conf-row', h('div', 'hud-bar', fill), h('span', 'hud-conf', `уверенность ${Math.round(p.confidence * 100)}%`)),
  );
  return h('div', 'hud-pctbox', h('div', 'hud-pct', h('b', 'hud-pct-num', `${Math.round(p.value)}%`), side), factors);
}

/** Итог фокуса матча — первым в разборе: получилось или нет, число против цели и вашего среднего, что сохранить */
function focusBlock(f: NonNullable<NonNullable<HudHint['review']>['focus']>, big: boolean): HTMLElement {
  const state = f.achieved === true ? 'ok' : f.achieved === false ? 'miss' : 'none';
  const verdict = f.achieved === true ? 'Получилось' : f.achieved === false ? 'Пока нет' : 'Не удалось измерить';
  return h(
    'div',
    `hud-focus-res hud-focus-${state}${big ? ' hud-focus-big' : ''}`,
    h('div', 'hud-focus-top', h('span', 'hud-focus-title', f.title), h('b', 'hud-focus-verdict', verdict)),
    h('div', 'hud-focus-num', h('b', null, f.value), h('span', null, ` · цель ${f.target}`)),
    f.avg ? h('div', 'hud-focus-avg', f.avg) : null,
    h('div', 'hud-focus-keep', f.keep),
  );
}

/** Опыт за матч: итог и строки «за что» — появляются по очереди (без движения при «Уменьшить анимации») */
function xpBlock(x: NonNullable<NonNullable<HudHint['review']>['xp']>): HTMLElement {
  const rows = x.items.map((i, n) => {
    const li = h('li', null, h('span', null, i.label), h('b', null, `+${i.xp}`));
    li.style.setProperty('--i', String(n));
    return li;
  });
  return h(
    'div',
    'hud-xp',
    h('div', 'hud-xp-top', h('b', 'hud-xp-total', x.total ? `+${x.total} опыта` : 'Опыта за матч нет'), h('span', 'hud-xp-level', x.levelUp ? `Новое звание: ${x.level}` : x.level)),
    rows.length ? h('ul', 'hud-xp-items', ...rows) : h('div', 'hud-xp-none', 'Опыт — только за выполненный фокус, советы и исправленные ошибки'),
    x.achievements.length ? h('div', 'hud-xp-ach', `Достижение: ${x.achievements.join(', ')}`) : null,
  );
}

function reviewBody(r: NonNullable<HudHint['review']>): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (r.focus) out.push(focusBlock(r.focus, r.focusOnly === true));
  if (r.xp) out.push(xpBlock(r.xp));
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
    const reason = hint.text ? reasonText(hint.title, hint.text) : '';
    if (reason) body.append(h('div', 'hud-text', reason));
    if (kind === 'decision' && hint.percent) body.append(percentBlock(hint.percent));
    const ttl = ttlBar(hint);
    if (ttl) body.append(ttl);
  }
  return [h('div', 'hud-glow', null), h('div', 'hud-frame', body)];
}

/**
 * Срок показа — в CSS-переменную корня: от неё тают полоса срока и «устаревание» (последние 30 % — плашка блекнет).
 * Повтор правила продлевает срок → переменная растёт → плашка снова яркая. Без таймеров в JS.
 */
export function applyTtl(el: HTMLElement, hint: HudHint): void {
  const live = hint.ttlMs > 0 && hint.zone !== 'review';
  el.classList.toggle('hud-ages', live);
  if (live) el.style.setProperty('--ttl', `${hint.ttlMs}ms`);
  else el.style.removeProperty('--ttl');
}

/** Корень карточки: вид зависит от важности и типа */
export function renderHint(hint: HudHint): HTMLElement {
  const root = h('div', `hud-card hud-k-${kindOf(hint)} hud-p-${hint.priority} hud-cat-${hint.category}`);
  root.dataset['seq'] = String(hint.seq);
  root.dataset['priority'] = hint.priority;
  root.append(...cardContent(hint));
  applyTtl(root, hint);
  return root;
}

/** Ключ содержимого: поменялся — перерисовать внутренность */
export function contentKey(hint: HudHint): string {
  return JSON.stringify([hint.title, hint.text, hint.percent, hint.review, hint.source, hint.priority]);
}

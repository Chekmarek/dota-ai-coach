// Эмблема коуча, угловой орнамент и значки важности — в духе Dota: металл, самоцвет, резные руны.
// Цвета — только CSS-переменные темы (через currentColor и var(--hud-c-*)).
import { svg } from './dom.ts';

/**
 * Эмблема: шестигранный самоцвет в металлической оправе с вырезанной руной «око».
 * Есть на каждой карточке: по нему подсказку коуча узнают за долю секунды, без слова «коуч».
 */
export function emblem(): SVGSVGElement {
  return svg('0 0 32 32', 'hud-gem', [
    // оправа
    ['path', { d: 'M16 1.5 28.5 8.7v14.6L16 30.5 3.5 23.3V8.7Z', fill: 'var(--hud-c-metalDark)', stroke: 'var(--hud-c-metalLight)', 'stroke-width': '1.4' }],
    // камень: грани
    ['path', { d: 'M16 5 25 10.2v11.6L16 27 7 21.8V10.2Z', fill: 'var(--hud-c-gemEdge)' }],
    ['path', { d: 'M16 5 25 10.2 16 15.4 7 10.2Z', fill: 'var(--hud-c-rune)', opacity: '0.85' }],
    ['path', { d: 'M16 15.4 25 10.2v11.6L16 27Z', fill: 'var(--hud-c-runeDeep)', opacity: '0.9' }],
    ['path', { d: 'M16 15.4 7 10.2v11.6L16 27Z', fill: 'var(--hud-c-rune)', opacity: '0.45' }],
    // руна «око»
    ['path', { d: 'M10.5 16c1.7-2.3 3.5-3.4 5.5-3.4s3.8 1.1 5.5 3.4c-1.7 2.3-3.5 3.4-5.5 3.4s-3.8-1.1-5.5-3.4Z', fill: 'none', stroke: 'var(--hud-c-gemCore)', 'stroke-width': '1.3' }],
    ['circle', { cx: '16', cy: '16', r: '1.7', fill: 'var(--hud-c-gemCore)' }],
    // блик
    ['path', { d: 'M11 9.2 15 7l-1.2 3.6Z', fill: '#fff', opacity: '0.55' }],
  ]);
}

/** Угловой орнамент рамки: кованая скоба с ромбом-заклёпкой (поворачивается CSS-классом угла) */
export function cornerOrnament(pos: 'tl' | 'tr' | 'bl' | 'br'): SVGSVGElement {
  return svg('0 0 32 32', `hud-corner hud-corner-${pos}`, [
    ['path', { d: 'M3 29V12Q3 3 12 3h17', fill: 'none', stroke: 'var(--hud-c-metalDark)', 'stroke-width': '5', 'stroke-linecap': 'round' }],
    ['path', { d: 'M3 29V12Q3 3 12 3h17', fill: 'none', stroke: 'var(--hud-c-metalLight)', 'stroke-width': '2.2', 'stroke-linecap': 'round' }],
    ['path', { d: 'M9.5 5.5 13 9l-3.5 3.5L6 9Z', fill: 'var(--hud-c-metal)', stroke: 'var(--hud-c-metalLight)', 'stroke-width': '1' }],
    ['circle', { cx: '9.5', cy: '9', r: '1.3', fill: 'var(--hud-c-rune)' }],
  ]);
}

/** Значок важности: критично — щит с «!», совет — рунная стрела, информация — руна-точка */
export function severityIcon(p: 'critical' | 'advice' | 'info'): SVGSVGElement {
  if (p === 'critical')
    return svg('0 0 24 24', 'hud-sev hud-sev-critical', [
      ['path', { d: 'M12 2.5 20 5.5v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6Z', fill: 'var(--hud-c-metalDark)', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' }],
      ['path', { d: 'M12 7.5v6', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round' }],
      ['circle', { cx: '12', cy: '16.8', r: '1.4', fill: 'currentColor' }],
    ]);
  if (p === 'advice')
    return svg('0 0 24 24', 'hud-sev hud-sev-advice', [
      ['path', { d: 'M12 2 21 12 12 22 3 12Z', fill: 'var(--hud-c-metalDark)', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }],
      ['path', { d: 'M8.5 12h7M12.5 8.5 16 12l-3.5 3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
    ]);
  return svg('0 0 24 24', 'hud-sev hud-sev-info', [
    ['path', { d: 'M12 3 20 12 12 21 4 12Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', opacity: '0.85' }],
    ['circle', { cx: '12', cy: '12', r: '2.4', fill: 'currentColor' }],
  ]);
}

/** Знак «написал ИИ»: маленькая магическая искра */
export function aiMark(): SVGSVGElement {
  return svg('0 0 24 24', 'hud-ai', [['path', { d: 'M12 2.5l1.9 6.6 6.6 1.9-6.6 1.9L12 19.5l-1.9-6.6L3.5 11l6.6-1.9Z', fill: 'currentColor' }]]);
}

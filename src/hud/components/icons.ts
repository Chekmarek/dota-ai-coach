// Эмблема коуча и значки важности. Цвета — только currentColor/CSS-переменные.
import { svg } from './dom.ts';

/**
 * Эмблема: «руна зрения» — ромб с вертикальным зрачком и тремя точками-звёздами над ним.
 * Есть на каждой карточке: по ней подсказку коуча узнают за долю секунды, без слова «коуч».
 */
export function emblem(): SVGSVGElement {
  return svg('0 0 24 24', 'hud-emblem', [
    ['path', { d: 'M12 2.5 21.5 12 12 21.5 2.5 12Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M12 7.2c1.6 1.4 2.4 3 2.4 4.8s-.8 3.4-2.4 4.8c-1.6-1.4-2.4-3-2.4-4.8s.8-3.4 2.4-4.8Z', fill: 'currentColor', opacity: '0.9' }],
    ['circle', { cx: '12', cy: '12', r: '1.1', fill: 'var(--hud-c-panelBottom)' }],
  ]);
}

/** Значок важности: критично — треугольник с «!», совет — компас-стрелка, информация — точка в кольце */
export function severityIcon(p: 'critical' | 'advice' | 'info'): SVGSVGElement {
  if (p === 'critical')
    return svg('0 0 24 24', 'hud-sev hud-sev-critical', [
      ['path', { d: 'M12 3 22 20H2Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linejoin': 'round' }],
      ['path', { d: 'M12 9.5v5', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' }],
      ['circle', { cx: '12', cy: '17.4', r: '1.3', fill: 'currentColor' }],
    ]);
  if (p === 'advice')
    return svg('0 0 24 24', 'hud-sev hud-sev-advice', [
      ['circle', { cx: '12', cy: '12', r: '9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' }],
      ['path', { d: 'M15.5 8.5 13.2 13.2 8.5 15.5 10.8 10.8Z', fill: 'currentColor' }],
    ]);
  return svg('0 0 24 24', 'hud-sev hud-sev-info', [
    ['circle', { cx: '12', cy: '12', r: '8.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', opacity: '0.8' }],
    ['circle', { cx: '12', cy: '12', r: '2.6', fill: 'currentColor' }],
  ]);
}

/** Значок ИИ (текст написал ИИ): маленькая искра */
export function aiMark(): SVGSVGElement {
  return svg('0 0 24 24', 'hud-ai', [['path', { d: 'M12 3l1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8Z', fill: 'currentColor' }]]);
}

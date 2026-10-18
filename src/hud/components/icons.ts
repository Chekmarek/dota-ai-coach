// Эмблема коуча и значки важности — плоские, в одну линию, цвет через currentColor и var(--hud-c-*).
import { svg } from './dom.ts';

/**
 * Эмблема: шестигранник с «оком» — фирменный знак коуча на каждой плашке
 * (по нему подсказку отличают от интерфейса Dota за долю секунды).
 */
export function emblem(): SVGSVGElement {
  return svg('0 0 24 24', 'hud-gem', [
    ['path', { d: 'M12 1.8 21 7v10l-9 5.2L3 17V7Z', fill: 'currentColor', opacity: '0.18' }],
    ['path', { d: 'M12 1.8 21 7v10l-9 5.2L3 17V7Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M7.2 12c1.4-1.9 3-2.9 4.8-2.9s3.4 1 4.8 2.9c-1.4 1.9-3 2.9-4.8 2.9s-3.4-1-4.8-2.9Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }],
    ['circle', { cx: '12', cy: '12', r: '1.6', fill: 'currentColor' }],
  ]);
}

/** Значок важности: критично — треугольник с «!», совет — стрелка в круге (информации значок не нужен) */
export function severityIcon(p: 'critical' | 'advice' | 'info'): SVGSVGElement {
  if (p === 'critical')
    return svg('0 0 24 24', 'hud-sev hud-sev-critical', [
      ['path', { d: 'M12 3.2 22 20.5H2Z', fill: 'currentColor', opacity: '0.2' }],
      ['path', { d: 'M12 3.2 22 20.5H2Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' }],
      ['path', { d: 'M12 9.5v5', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round' }],
      ['circle', { cx: '12', cy: '17.6', r: '1.25', fill: 'currentColor' }],
    ]);
  if (p === 'advice')
    return svg('0 0 24 24', 'hud-sev hud-sev-advice', [
      ['circle', { cx: '12', cy: '12', r: '9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7' }],
      ['path', { d: 'M8 12h7.5M12.5 8.5 16 12l-3.5 3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
    ]);
  return svg('0 0 24 24', 'hud-sev hud-sev-info', [['circle', { cx: '12', cy: '12', r: '3', fill: 'currentColor' }]]);
}

/** Знак «написал ИИ»: маленькая магическая искра */
export function aiMark(): SVGSVGElement {
  return svg('0 0 24 24', 'hud-ai', [['path', { d: 'M12 2.5l1.9 6.6 6.6 1.9-6.6 1.9L12 19.5l-1.9-6.6L3.5 11l6.6-1.9Z', fill: 'currentColor' }]]);
}

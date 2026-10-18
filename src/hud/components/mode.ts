// Индикатор режима игры (0.13.3): крупная плашка «Режим игры — Турбо» сверху по центру, под верхней панелью Dota
// (зона «Важное» — она не залезает на HUD игры). Появляется в начале матча и при смене режима, сама уходит.
// Вид — та же стеклянная плашка, что у подсказок; цвет акцента — по режиму (CSS-переменные темы).
import type { ModeBanner } from '../../shared/types/hud.ts';
import { h, svg } from './dom.ts';

/** Знак режима в шестиграннике: Турбо — молния, All Pick — скрещённые клинки, другое — руна-ромб, неизвестно — «?» */
export function modeIcon(mode: ModeBanner['mode']): SVGSVGElement {
  const rune: [string, Record<string, string>][] =
    mode === 'turbo'
      ? [['path', { d: 'M18.2 6.5 10.8 17.4h4.6l-1.6 8.1 7.4-10.9h-4.6Z', fill: 'var(--mode-c)', stroke: 'none', 'stroke-width': '0', 'stroke-linejoin': 'round' }]]
      : mode === 'all-pick'
        ? [
            ['path', { d: 'M9.5 9.5 22.5 22.5M22.5 9.5 9.5 22.5', stroke: 'var(--hud-c-gemCore)', 'stroke-width': '2.2', 'stroke-linecap': 'round' }],
            ['path', { d: 'M8 13.5 13.5 8M18.5 24 24 18.5M24 13.5 18.5 8M13.5 24 8 18.5', stroke: 'var(--hud-c-muted)', 'stroke-width': '1.4', 'stroke-linecap': 'round' }],
          ]
        : mode === 'other'
          ? [['path', { d: 'M16 9.5 22.5 16 16 22.5 9.5 16Z', fill: 'none', stroke: 'var(--hud-c-gemCore)', 'stroke-width': '1.8' }]]
          : [
              ['path', { d: 'M12.6 13.2c0-2 1.5-3.4 3.5-3.4s3.4 1.3 3.4 3.1c0 2.6-3.3 2.7-3.3 5.3', fill: 'none', stroke: 'var(--hud-c-gemCore)', 'stroke-width': '2', 'stroke-linecap': 'round' }],
              ['circle', { cx: '16.2', cy: '22.2', r: '1.3', fill: 'var(--hud-c-gemCore)' }],
            ];
  return svg('0 0 32 32', 'hud-mode-icon', [
    ['path', { d: 'M16 2.5 27.7 9.2v13.6L16 29.5 4.3 22.8V9.2Z', fill: 'var(--mode-c)', opacity: '0.16' }],
    ['path', { d: 'M16 2.5 27.7 9.2v13.6L16 29.5 4.3 22.8V9.2Z', fill: 'none', stroke: 'var(--mode-c)', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }],
    ...rune,
  ]);
}

/** Подпись: для Турбо/All Pick — «Режим игры. Определён по данным игры»; у остальных текст уже про режим */
export function modeSub(b: Pick<ModeBanner, 'mode' | 'text'>): string {
  return b.mode === 'turbo' || b.mode === 'all-pick' ? `Режим игры. ${b.text}` : b.text;
}

export function renderModeBanner(b: ModeBanner): HTMLElement {
  const root = h('div', `hud-mode hud-mode-${b.mode}`);
  root.dataset['seq'] = String(b.seq);
  root.dataset['mode'] = b.mode;
  root.dataset['testid'] = 'hud-mode';
  const body = h(
    'div',
    'hud-body hud-mode-body',
    modeIcon(b.mode),
    h('div', 'hud-mode-txt', h('span', 'hud-title hud-mode-title', b.title), h('span', 'hud-mode-sub', modeSub(b))),
    h('i', 'hud-mode-sweep', null),
  );
  root.append(h('div', 'hud-glow hud-mode-glow', null), h('div', 'hud-frame', body));
  return root;
}

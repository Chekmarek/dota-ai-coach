// Индикатор режима игры (0.13.3): крупная плашка «Режим игры — Турбо» сверху по центру, под верхней панелью Dota
// (зона «Важное» — она не залезает на HUD игры). Появляется в начале матча и при смене режима, сама уходит.
// Вид — та же каменная плита в кованой рамке, что у подсказок; цвет магии — по режиму (CSS-переменные темы).
import type { ModeBanner } from '../../shared/types/hud.ts';
import { h, svg } from './dom.ts';
import { cornerOrnament } from './icons.ts';

/** Знак режима в самоцвете: Турбо — молния, All Pick — скрещённые клинки, другое — руна-ромб, неизвестно — «?» */
export function modeIcon(mode: ModeBanner['mode']): SVGSVGElement {
  const rune: [string, Record<string, string>][] =
    mode === 'turbo'
      ? [['path', { d: 'M18.2 6.5 10.8 17.4h4.6l-1.6 8.1 7.4-10.9h-4.6Z', fill: 'var(--mode-c)', stroke: 'var(--hud-c-metalDark)', 'stroke-width': '0.8', 'stroke-linejoin': 'round' }]]
      : mode === 'all-pick'
        ? [
            ['path', { d: 'M9.5 9.5 22.5 22.5M22.5 9.5 9.5 22.5', stroke: 'var(--hud-c-gemCore)', 'stroke-width': '2.2', 'stroke-linecap': 'round' }],
            ['path', { d: 'M8 13.5 13.5 8M18.5 24 24 18.5M24 13.5 18.5 8M13.5 24 8 18.5', stroke: 'var(--hud-c-metalLight)', 'stroke-width': '1.4', 'stroke-linecap': 'round' }],
          ]
        : mode === 'other'
          ? [['path', { d: 'M16 9.5 22.5 16 16 22.5 9.5 16Z', fill: 'none', stroke: 'var(--hud-c-gemCore)', 'stroke-width': '1.8' }]]
          : [
              ['path', { d: 'M12.6 13.2c0-2 1.5-3.4 3.5-3.4s3.4 1.3 3.4 3.1c0 2.6-3.3 2.7-3.3 5.3', fill: 'none', stroke: 'var(--hud-c-gemCore)', 'stroke-width': '2', 'stroke-linecap': 'round' }],
              ['circle', { cx: '16.2', cy: '22.2', r: '1.3', fill: 'var(--hud-c-gemCore)' }],
            ];
  return svg('0 0 32 32', 'hud-mode-icon', [
    ['path', { d: 'M16 1.5 28.5 8.7v14.6L16 30.5 3.5 23.3V8.7Z', fill: 'var(--hud-c-metalDark)', stroke: 'var(--hud-c-metalLight)', 'stroke-width': '1.4' }],
    ['path', { d: 'M16 4.5 25.5 10v12L16 27.5 6.5 22V10Z', fill: 'var(--mode-deep)' }],
    ['path', { d: 'M16 4.5 25.5 10 16 15.5 6.5 10Z', fill: 'var(--mode-c)', opacity: '0.55' }],
    ...rune,
    ['path', { d: 'M10.5 8.8 14.5 6.6l-1.2 3.6Z', fill: '#fff', opacity: '0.5' }],
  ]);
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
    h('div', 'hud-mode-txt', h('span', 'hud-mode-kicker', 'Режим игры'), h('span', 'hud-title hud-mode-title', b.title), h('span', 'hud-mode-sub', b.text)),
    h('i', 'hud-mode-sweep', null),
  );
  root.append(h('div', 'hud-glow hud-mode-glow', null), h('div', 'hud-frame', body), cornerOrnament('tl'), cornerOrnament('tr'), cornerOrnament('bl'), cornerOrnament('br'));
  return root;
}

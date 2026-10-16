// Схема экрана Dota для предпросмотра без снимка игры: запретные области HUD — полупрозрачные подписанные блоки.
import { resolveLayout, type HudLayout } from '../core/hud/layout.ts';
import { h } from './components/dom.ts';

export function schematic(layout: HudLayout, width: number, height: number): HTMLElement {
  const root = h('div', 'hud-schematic');
  for (const f of resolveLayout(layout, width, height).forbidden) {
    const el = h('div', 'hud-forbidden', h('span', null, f.area.nameRu));
    Object.assign(el.style, { left: `${f.rect.x}px`, top: `${f.rect.y}px`, width: `${f.rect.w}px`, height: `${f.rect.h}px` });
    root.append(el);
  }
  return root;
}

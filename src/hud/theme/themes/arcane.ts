// Тема «Аркан» (по умолчанию): тёмный камень, тонкая бронза, холодное бирюзовое свечение —
// цвета, которых нет в HUD Dota (там золото, красный и зелёный), поэтому подсказку не спутать с игрой.
import { stoneTexture, type HudTheme } from '../tokens.ts';

export const ARCANE: HudTheme = {
  id: 'arcane',
  nameRu: 'Аркан',
  noteRu: 'Тёмный камень, бронзовая рамка и холодное бирюзовое свечение',
  color: {
    accent: '#3fe3d0',
    accentSoft: 'rgba(63, 227, 208, 0.16)',
    glowCritical: 'rgba(63, 227, 208, 0.75)',
    glowAdvice: 'rgba(63, 227, 208, 0.38)',
    glowInfo: 'rgba(63, 227, 208, 0.0)',
    critical: '#ff6b4f',
    advice: '#3fe3d0',
    info: '#9fb6ba',
    panelTop: 'rgba(30, 36, 40, 0.94)',
    panelBottom: 'rgba(14, 17, 20, 0.94)',
    border: '#7a5c34',
    borderHi: '#c9a46a',
    title: '#eedcb0',
    text: '#d6dcdc',
    muted: '#8d999b',
    good: '#7fd88a',
    bad: '#ff8a70',
    barTrack: 'rgba(255, 255, 255, 0.10)',
  },
  font: {
    display: "'HudDisplay', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
    body: "'Segoe UI', 'Noto Sans', system-ui, sans-serif",
  },
  size: { title: 19, text: 15.5, small: 13, percent: 30, icon: 22, emblem: 15, pad: 11, gap: 8, chamfer: 10, spine: 3, border: 1.2, bar: 4, cardWidth: 300 },
  shadow: { card: '0 4px 14px rgba(0, 0, 0, 0.55)', glowBlur: 14 },
  duration: { enter: 280, exit: 200, reflow: 220, update: 180, pulse: 1400 },
  easing: { out: 'cubic-bezier(0.16, 1, 0.3, 1)', in: 'cubic-bezier(0.55, 0, 1, 0.45)', inOut: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  texture: stoneTexture(0.06),
};

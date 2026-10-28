// Тема «Бирюза» (была основной до 0.22; id «teal» — с 0.22, прежний id «runes» теперь у темы «Дота»):
// тёмное полупрозрачное стекло, тонкая светлая кромка и один бирюзовый акцент.
// Бирюзового в HUD Dota нет, поэтому подсказку коуча не спутать с игрой.
import type { HudTheme } from '../tokens.ts';

export const TEAL: HudTheme = {
  id: 'teal',
  nameRu: 'Бирюза',
  noteRu: 'Тёмное стекло и бирюзовый акцент',
  color: {
    rune: '#3ee6d2',
    runeSoft: 'rgba(62, 230, 210, 0.2)',
    runeDeep: '#0e5f59',
    gemCore: '#d9fffa',
    gemEdge: '#127a73',
    critical: '#ff5a43',
    criticalGlow: 'rgba(255, 90, 67, 0.55)',
    advice: '#3ee6d2',
    adviceGlow: 'rgba(62, 230, 210, 0.32)',
    info: '#8a96a8',
    stoneLight: 'rgba(24, 28, 35, 0.9)',
    stoneDark: 'rgba(12, 14, 18, 0.9)',
    carve: 'rgba(255, 255, 255, 0.08)',
    metalDark: 'rgba(255, 255, 255, 0.04)',
    metal: 'rgba(255, 255, 255, 0.08)',
    metalLight: 'rgba(255, 255, 255, 0.2)',
    titleTop: '#f3f6f9',
    titleBottom: '#f3f6f9',
    text: '#c9d1dc',
    muted: '#8a96a8',
    good: '#5fd68a',
    bad: '#ff7a63',
    groove: 'rgba(255, 255, 255, 0.1)',
    turbo: '#ffb547',
    turboGlow: 'rgba(255, 181, 71, 0.45)',
  },
  font: {
    display: "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
    body: "'Segoe UI Variable Text', 'Segoe UI', 'Noto Sans', system-ui, sans-serif",
  },
  size: { title: 13.5, text: 12, small: 10.5, percent: 19, icon: 14, gem: 15, pad: 7.5, gap: 6, bevel: 5, frame: 1, corner: 0, bar: 3, medallion: 36, cardWidth: 240 },
  shadow: { card: '0 4px 14px rgba(0, 0, 0, 0.55)', glowBlur: 10 },
  duration: { enter: 260, exit: 180, reflow: 220, update: 200, pulse: 1400 },
  easing: { out: 'cubic-bezier(0.16, 1, 0.3, 1)', in: 'cubic-bezier(0.55, 0, 1, 0.45)', inOut: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  texture: '',
};

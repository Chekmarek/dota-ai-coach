// Тема «Коуч» (основная с 0.22.1; id «runes» — прежний id основной темы, поэтому новый вид включается у всех сам):
// по концепту владельца, в одном стиле с окном коуча. Тёплая почти чёрная плашка со скруглением и тонкой тёплой
// рамкой, заголовок — кремовая антиква Charis SIL, медь — советы, полосы и цифры; красный — срочно и знак коуча;
// зелёный — «хорошо». Текст — Segoe UI (на долю секунды поверх игры антиква мелким кеглем читалась бы хуже).
import type { HudTheme } from '../tokens.ts';

export const COACH: HudTheme = {
  id: 'runes',
  nameRu: 'Коуч',
  noteRu: 'Как окно коуча: тёплая тёмная плашка, кремовая антиква, медь',
  color: {
    rune: '#e3966f',
    runeSoft: 'rgba(227, 150, 111, 0.18)',
    runeDeep: '#5a2a18',
    gemCore: '#ffe9da',
    gemEdge: '#8a3a22',
    critical: '#ef5b5e',
    criticalGlow: 'rgba(239, 91, 94, 0.5)',
    advice: '#e3966f',
    adviceGlow: 'rgba(227, 150, 111, 0.26)',
    info: '#a59a95',
    stoneLight: 'rgba(24, 18, 19, 0.93)',
    stoneDark: 'rgba(10, 7, 8, 0.93)',
    carve: 'rgba(255, 236, 225, 0.09)',
    metalDark: 'rgba(255, 236, 225, 0.05)',
    metal: 'rgba(255, 236, 225, 0.1)',
    metalLight: 'rgba(255, 220, 200, 0.24)',
    titleTop: '#f2e5d6',
    titleBottom: '#f2e5d6',
    text: '#d9d0cb',
    muted: '#a59a95',
    good: '#6cc28a',
    bad: '#ef6e64',
    groove: 'rgba(255, 236, 225, 0.1)',
    turbo: '#ffb547',
    turboGlow: 'rgba(255, 181, 71, 0.45)',
    mark: '#d9444d',
  },
  font: {
    display: "'Charis SIL', 'PT Serif', Georgia, serif",
    body: "'Segoe UI Variable Text', 'Segoe UI', 'Noto Sans', system-ui, sans-serif",
    titleCase: 'none',
    titleTracking: 0,
    titleWeight: 700,
  },
  size: { title: 14.5, text: 12, small: 10.5, percent: 20, icon: 14, gem: 15, pad: 8, gap: 6, bevel: 7, frame: 1, corner: 0, bar: 3, medallion: 36, cardWidth: 240 },
  shadow: { card: '0 8px 22px rgba(0, 0, 0, 0.6)', glowBlur: 9 },
  duration: { enter: 260, exit: 180, reflow: 220, update: 200, pulse: 1400 },
  easing: { out: 'cubic-bezier(0.16, 1, 0.3, 1)', in: 'cubic-bezier(0.55, 0, 1, 0.45)', inOut: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  texture: '',
};

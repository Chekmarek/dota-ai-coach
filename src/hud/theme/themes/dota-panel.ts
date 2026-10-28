// Тема «Дота» (основная в 0.22; с 0.22.1 — id «dota», основной стала тема «Коуч» по концепту владельца). Плашка — как родная панель Доты: тёмный сланец с синевой, тонкая светлая рамка, прямые углы,
// заголовок прописными с разрядкой (как название способности в подсказке игры), шрифт Ysabeau (свободная замена
// шрифтов Доты). Метка коуча — золотой знак: золото в Доте есть, но не у системных сообщений, поэтому плашка
// выглядит своей и всё же отличима от сообщения игры. Срочно — красный Сил Тьмы, хорошо — зелёный Сил Света.
import type { HudTheme } from '../tokens.ts';

export const DOTA: HudTheme = {
  id: 'dota',
  nameRu: 'Дота',
  noteRu: 'Как панель самой игры: сланец, прямые углы, золотой знак коуча',
  color: {
    rune: '#e2bc66',
    runeSoft: 'rgba(226, 188, 102, 0.18)',
    runeDeep: '#5c4818',
    gemCore: '#fff1c9',
    gemEdge: '#8a6a22',
    critical: '#e8492f',
    criticalGlow: 'rgba(232, 73, 47, 0.5)',
    advice: '#e2bc66',
    adviceGlow: 'rgba(226, 188, 102, 0.22)',
    info: '#8794a2',
    stoneLight: 'rgba(27, 33, 41, 0.93)',
    stoneDark: 'rgba(11, 14, 18, 0.93)',
    carve: 'rgba(255, 255, 255, 0.09)',
    metalDark: 'rgba(255, 255, 255, 0.05)',
    metal: 'rgba(255, 255, 255, 0.1)',
    metalLight: 'rgba(255, 255, 255, 0.26)',
    titleTop: '#f4f5f6',
    titleBottom: '#f4f5f6',
    text: '#c3cad2',
    muted: '#8a96a3',
    good: '#7fcb4f',
    bad: '#ef6a52',
    groove: 'rgba(255, 255, 255, 0.1)',
    turbo: '#ffb547',
    turboGlow: 'rgba(255, 181, 71, 0.45)',
  },
  font: {
    display: "'Ysabeau', 'Ysabeau Office', 'Segoe UI', system-ui, sans-serif",
    body: "'Ysabeau Office', 'Segoe UI', 'Noto Sans', system-ui, sans-serif",
    titleCase: 'uppercase',
    titleTracking: 0.045,
    titleWeight: 700,
  },
  // У Ysabeau Office буквы ниже, чем у Segoe UI того же кегля, — текст и число чуть крупнее; ширина плашки прежняя
  size: { title: 13.5, text: 12.8, small: 11, percent: 21, icon: 14, gem: 14, pad: 7.5, gap: 6, bevel: 0, frame: 1, corner: 0, bar: 3, medallion: 36, cardWidth: 240 },
  shadow: { card: '0 6px 16px rgba(0, 0, 0, 0.6)', glowBlur: 6 },
  duration: { enter: 260, exit: 180, reflow: 220, update: 200, pulse: 1400 },
  easing: { out: 'cubic-bezier(0.16, 1, 0.3, 1)', in: 'cubic-bezier(0.55, 0, 1, 0.45)', inOut: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  texture: '',
};

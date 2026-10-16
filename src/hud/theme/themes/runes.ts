// Тема «Древние руны» (по умолчанию): тёмный камень, кованая бронза с золотым бликом, бирюзовые светящиеся руны
// и самоцвет — как артефакт из лавки Dota. Бирюзовой магии в HUD Dota нет, поэтому подсказку не спутать с игрой.
import { stoneTexture, type HudTheme } from '../tokens.ts';

export const RUNES: HudTheme = {
  id: 'runes',
  nameRu: 'Древние руны',
  noteRu: 'Тёмный камень, кованая бронза и бирюзовые светящиеся руны',
  color: {
    rune: '#4ff0dc',
    runeSoft: 'rgba(79, 240, 220, 0.22)',
    runeDeep: '#0f6f6a',
    gemCore: '#b8fff4',
    gemEdge: '#127a73',
    critical: '#ff4a2e',
    criticalGlow: 'rgba(255, 74, 46, 0.7)',
    advice: '#4ff0dc',
    adviceGlow: 'rgba(79, 240, 220, 0.45)',
    info: '#b9a77f',
    stoneLight: 'rgba(48, 46, 42, 0.96)',
    stoneDark: 'rgba(14, 13, 12, 0.97)',
    carve: 'rgba(205, 168, 102, 0.28)',
    metalDark: '#3a2712',
    metal: '#8a6232',
    metalLight: '#e9c57f',
    titleTop: '#fbe7b4',
    titleBottom: '#c99a4b',
    text: '#e3dccb',
    muted: '#9a9078',
    good: '#8fdc7a',
    bad: '#ff7b5c',
    groove: 'rgba(0, 0, 0, 0.55)',
  },
  font: {
    display: "'HudDisplay', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
    body: "'Segoe UI', 'Noto Sans', system-ui, sans-serif",
  },
  size: { title: 19, text: 15.5, small: 13, percent: 26, icon: 20, gem: 30, pad: 13, gap: 9, bevel: 9, frame: 3, corner: 22, bar: 5, medallion: 58, cardWidth: 320 },
  shadow: { card: '0 6px 18px rgba(0, 0, 0, 0.7), 0 0 2px rgba(0, 0, 0, 0.9)', glowBlur: 16 },
  duration: { enter: 340, exit: 220, reflow: 240, update: 220, pulse: 1500 },
  easing: { out: 'cubic-bezier(0.16, 1, 0.3, 1)', in: 'cubic-bezier(0.55, 0, 1, 0.45)', inOut: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  texture: stoneTexture([0.55, 0.47, 0.36], 0.12),
};

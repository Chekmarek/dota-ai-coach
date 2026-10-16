// Тема «Обсидиан» (вариант): чёрное вулканическое стекло, тёмная медь с кровавым бликом, фиолетовая магия —
// в духе Сил Тьмы. Компоненты те же, отличаются только токены.
import { stoneTexture, type HudTheme } from '../tokens.ts';

export const OBSIDIAN: HudTheme = {
  id: 'obsidian',
  nameRu: 'Обсидиан',
  noteRu: 'Чёрный обсидиан, тёмная медь и фиолетовая магия',
  color: {
    rune: '#b48cff',
    runeSoft: 'rgba(180, 140, 255, 0.24)',
    runeDeep: '#4b2a8a',
    gemCore: '#f0e2ff',
    gemEdge: '#5a2ea0',
    critical: '#ff3b3b',
    criticalGlow: 'rgba(255, 50, 50, 0.7)',
    advice: '#c3a2ff',
    adviceGlow: 'rgba(180, 140, 255, 0.5)',
    info: '#a99ab8',
    stoneLight: 'rgba(36, 32, 42, 0.96)',
    stoneDark: 'rgba(8, 7, 11, 0.97)',
    carve: 'rgba(196, 120, 92, 0.28)',
    metalDark: '#2a110c',
    metal: '#7a3a26',
    metalLight: '#e09a74',
    titleTop: '#f6dcd0',
    titleBottom: '#c27a5c',
    text: '#e2dbe6',
    muted: '#968aa3',
    good: '#8fdc9a',
    bad: '#ff7f7f',
    groove: 'rgba(0, 0, 0, 0.6)',
  },
  font: {
    display: "'HudDisplay', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
    body: "'Segoe UI', 'Noto Sans', system-ui, sans-serif",
  },
  size: { title: 19, text: 15.5, small: 13, percent: 26, icon: 20, gem: 30, pad: 13, gap: 9, bevel: 12, frame: 3, corner: 24, bar: 5, medallion: 58, cardWidth: 320 },
  shadow: { card: '0 6px 20px rgba(0, 0, 0, 0.75), 0 0 2px rgba(0, 0, 0, 0.9)', glowBlur: 18 },
  duration: { enter: 360, exit: 220, reflow: 240, update: 220, pulse: 1700 },
  easing: { out: 'cubic-bezier(0.22, 1, 0.36, 1)', in: 'cubic-bezier(0.55, 0, 1, 0.45)', inOut: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  texture: stoneTexture([0.42, 0.36, 0.5], 0.1),
};

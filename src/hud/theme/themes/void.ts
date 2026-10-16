// Тема «Пустота» (вариант): холодный тёмно-синий камень, серебристо-бронзовая рамка и лиловое свечение.
// Отличается от «Аркана» только токенами — компоненты те же.
import { stoneTexture, type HudTheme } from '../tokens.ts';

export const VOID: HudTheme = {
  id: 'void',
  nameRu: 'Пустота',
  noteRu: 'Синий камень, серебристая бронза и лиловое свечение',
  color: {
    accent: '#a48dff',
    accentSoft: 'rgba(164, 141, 255, 0.16)',
    glowCritical: 'rgba(164, 141, 255, 0.8)',
    glowAdvice: 'rgba(164, 141, 255, 0.4)',
    glowInfo: 'rgba(164, 141, 255, 0.0)',
    critical: '#ff6b6b',
    advice: '#b9a6ff',
    info: '#a3a9c4',
    panelTop: 'rgba(28, 28, 44, 0.94)',
    panelBottom: 'rgba(12, 12, 22, 0.94)',
    border: '#6d6576',
    borderHi: '#c8bfd6',
    title: '#ece6ff',
    text: '#d9d8e6',
    muted: '#8f8ca6',
    good: '#86e0a0',
    bad: '#ff8f8f',
    barTrack: 'rgba(255, 255, 255, 0.10)',
  },
  font: {
    display: "'HudDisplay', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
    body: "'Segoe UI', 'Noto Sans', system-ui, sans-serif",
  },
  size: { title: 19, text: 15.5, small: 13, percent: 30, icon: 22, emblem: 15, pad: 11, gap: 8, chamfer: 14, spine: 2, border: 1, bar: 3, cardWidth: 300 },
  shadow: { card: '0 6px 18px rgba(0, 0, 0, 0.6)', glowBlur: 18 },
  duration: { enter: 300, exit: 200, reflow: 240, update: 180, pulse: 1600 },
  easing: { out: 'cubic-bezier(0.22, 1, 0.36, 1)', in: 'cubic-bezier(0.55, 0, 1, 0.45)', inOut: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  texture: stoneTexture(0.05),
};

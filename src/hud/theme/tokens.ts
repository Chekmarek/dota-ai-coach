// Дизайн-токены подсказок поверх игры. ВСЕ визуальные решения — здесь и в файлах тем (themes/*.ts):
// компоненты и hud.css берут только CSS-переменные --hud-*. Новая тема = новый файл с HudTheme.
// Размеры — в «тысячных u» (u = min(высота, ширина × 9/16), см. src/core/hud/layout.ts): 18 = 1,8 % высоты
// экрана 16:9, поэтому одинаково смотрится на ноутбуке и на телевизоре.

export interface HudTheme {
  id: string;
  nameRu: string;
  /** Одна фраза: что делает тему узнаваемой */
  noteRu: string;
  color: {
    /** Фирменный акцент коуча (не встречается в HUD Dota) */
    accent: string;
    accentSoft: string;
    /** Свечение рамки по важности */
    glowCritical: string;
    glowAdvice: string;
    glowInfo: string;
    /** Цвет значка важности */
    critical: string;
    advice: string;
    info: string;
    /** Камень панели: верх и низ градиента */
    panelTop: string;
    panelBottom: string;
    /** Тонкая бронзовая рамка */
    border: string;
    borderHi: string;
    title: string;
    text: string;
    muted: string;
    good: string;
    bad: string;
    barTrack: string;
  };
  font: {
    display: string;
    body: string;
  };
  /** Размеры в тысячных u */
  size: {
    title: number;
    text: number;
    small: number;
    percent: number;
    icon: number;
    emblem: number;
    pad: number;
    gap: number;
    /** Срез углов карточки */
    chamfer: number;
    /** Фирменная полоса слева */
    spine: number;
    border: number;
    bar: number;
    cardWidth: number;
  };
  shadow: {
    card: string;
    /** Размытие свечения в тысячных u */
    glowBlur: number;
  };
  /** Длительности, мс */
  duration: {
    enter: number;
    exit: number;
    reflow: number;
    update: number;
    pulse: number;
  };
  easing: {
    out: string;
    in: string;
    inOut: string;
  };
  /** Фон-текстура камня (data:image/svg+xml) */
  texture: string;
}

/** Тема → CSS-переменные (ставятся на корень оверлея или предпросмотра) */
export function themeVars(t: HudTheme, unitPx: number, scale: number, opacity: number): Record<string, string> {
  const s = (n: number) => `${((n * unitPx) / 1000) * scale}px`;
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.color)) vars[`--hud-c-${k}`] = v;
  vars['--hud-font-display'] = t.font.display;
  vars['--hud-font-body'] = t.font.body;
  for (const [k, v] of Object.entries(t.size)) vars[`--hud-s-${k}`] = s(v);
  vars['--hud-shadow-card'] = t.shadow.card;
  vars['--hud-glow-blur'] = s(t.shadow.glowBlur);
  for (const [k, v] of Object.entries(t.duration)) vars[`--hud-d-${k}`] = `${v}ms`;
  for (const [k, v] of Object.entries(t.easing)) vars[`--hud-e-${k}`] = v;
  vars['--hud-texture'] = `url("${t.texture}")`;
  vars['--hud-opacity'] = String(opacity);
  return vars;
}

/** Тонкий шум «камня»: SVG feTurbulence, без файлов */
export function stoneTexture(alpha: number): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${alpha} 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`;
  return `data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/"/g, "'")}`;
}

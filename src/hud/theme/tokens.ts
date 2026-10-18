// Дизайн-токены подсказок поверх игры. ВСЕ визуальные решения — здесь и в файлах тем (themes/*.ts):
// компоненты и hud.css берут только CSS-переменные --hud-*. Новая тема = новый файл с HudTheme.
// Стиль — «как часть Dota»: тёмный камень, кованый металл рамки, резные руны, светящийся самоцвет, магия.
// Размеры — в «тысячных u» (u = min(высота, ширина × 9/16), см. src/core/hud/layout.ts): 18 = 1,8 % высоты
// экрана 16:9, поэтому одинаково смотрится на ноутбуке и на телевизоре.

export interface HudTheme {
  id: string;
  nameRu: string;
  /** Одна фраза: что делает тему узнаваемой */
  noteRu: string;
  color: {
    /** Фирменная магия коуча: свечение рун и самоцвета (в HUD Dota такого цвета нет) */
    rune: string;
    runeSoft: string;
    runeDeep: string;
    /** Самоцвет эмблемы: сердцевина и грань */
    gemCore: string;
    gemEdge: string;
    /** Цвет значка и свечения по важности */
    critical: string;
    criticalGlow: string;
    advice: string;
    adviceGlow: string;
    info: string;
    /** Камень панели: светлее в центре, темнее к краям */
    stoneLight: string;
    stoneDark: string;
    /** Резная линия внутри камня */
    carve: string;
    /** Кованый металл рамки: тень, тело, блик */
    metalDark: string;
    metal: string;
    metalLight: string;
    /** Заголовок — золото: верх и низ градиента */
    titleTop: string;
    titleBottom: string;
    text: string;
    muted: string;
    good: string;
    bad: string;
    groove: string;
    /** Индикатор режима «Турбо»: янтарный огонь (All Pick — цвет рун, неизвестный — info) */
    turbo: string;
    turboGlow: string;
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
    gem: number;
    pad: number;
    gap: number;
    /** Скос углов панели */
    bevel: number;
    /** Толщина металлической рамки */
    frame: number;
    /** Угловой орнамент */
    corner: number;
    bar: number;
    medallion: number;
    cardWidth: number;
  };
  shadow: {
    card: string;
    /** Размытие магического свечения в тысячных u */
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
  /** Фактура камня (data:image/svg+xml) */
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

/**
 * Фактура камня без файлов: крупные пятна (низкая частота) + мелкое зерно + редкие трещинки.
 * tint — оттенок пятен (r g b 0…1), alpha — сила.
 */
export function stoneTexture(tint: [number, number, number], alpha: number): string {
  const [r, g, b] = tint;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>` +
    `<filter id='m'><feTurbulence type='fractalNoise' baseFrequency='0.018' numOctaves='4' seed='7'/>` +
    `<feColorMatrix values='0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  0 0 0 ${alpha * 2.2} -${alpha * 0.9}'/></filter>` +
    `<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='3'/>` +
    `<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${alpha} 0'/></filter>` +
    `<filter id='c'><feTurbulence type='turbulence' baseFrequency='0.045' numOctaves='2' seed='11'/>` +
    `<feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -9 1.9'/></filter>` +
    `<rect width='100%' height='100%' filter='url(#m)'/><rect width='100%' height='100%' filter='url(#g)'/>` +
    `<rect width='100%' height='100%' filter='url(#c)' opacity='${Math.min(0.16, alpha * 1.2)}'/></svg>`;
  return `data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/"/g, "'")}`;
}

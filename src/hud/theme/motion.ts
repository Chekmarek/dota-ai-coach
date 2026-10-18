// Анимации подсказок — именованные пресеты в одном месте. Только transform и opacity (работает видеокарта,
// процессор не нагружается). Длительности и кривые — из темы (duration/easing). «Уменьшить анимации» —
// без движения, короткое проявление, без пульса.
import type { HudTheme } from './tokens.ts';

export type Edge = 'top' | 'bottom' | 'left' | 'right';

export interface MotionPreset {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

const offset = (edge: Edge, d: string): string =>
  edge === 'top' ? `translate3d(0, -${d}, 0)` : edge === 'bottom' ? `translate3d(0, ${d}, 0)` : edge === 'left' ? `translate3d(-${d}, 0, 0)` : `translate3d(${d}, 0, 0)`;

export const MOTION = {
  /** Выезд из края зоны и проявление */
  enter(t: HudTheme, edge: Edge, reduced: boolean): MotionPreset {
    if (reduced) return { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 120, easing: 'linear', fill: 'both' } };
    return {
      keyframes: [
        { opacity: 0, transform: `${offset(edge, '36px')} scale(0.94)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1.015)', offset: 0.7 },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
      ],
      options: { duration: t.duration.enter, easing: t.easing.out, fill: 'both' },
    };
  },
  /** Уход обратно к краю */
  exit(t: HudTheme, edge: Edge, reduced: boolean): MotionPreset {
    if (reduced) return { keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 100, easing: 'linear', fill: 'both' } };
    return {
      keyframes: [
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        { opacity: 0, transform: offset(edge, '30px') },
      ],
      options: { duration: t.duration.exit, easing: t.easing.in, fill: 'both' },
    };
  },
  /** Плавная перестройка стопки (FLIP): из старого места в новое */
  reflow(t: HudTheme, dx: number, dy: number, reduced: boolean): MotionPreset | null {
    if (reduced || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) return null;
    return {
      keyframes: [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      options: { duration: t.duration.reflow, easing: t.easing.inOut },
    };
  },
  /** Мягкий пульс свечения у критичных (3 раза, потом ровное свечение — бережём процессор) */
  pulse(t: HudTheme, reduced: boolean): MotionPreset | null {
    if (reduced) return null;
    return {
      keyframes: [{ opacity: 0.45 }, { opacity: 1 }, { opacity: 0.45 }],
      options: { duration: t.duration.pulse, easing: 'ease-in-out', iterations: 3 },
    };
  },
  /** Проявление магии при появлении: свечение вспыхивает и гаснет до обычного */
  flash(t: HudTheme, reduced: boolean): MotionPreset | null {
    if (reduced) return null;
    return { keyframes: [{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0.6 }], options: { duration: t.duration.enter * 2, easing: 'ease-out' } };
  },
  /** Индикатор режима: падает сверху с лёгким перелётом */
  modeEnter(t: HudTheme, reduced: boolean): MotionPreset {
    if (reduced) return { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 160, easing: 'linear', fill: 'both' } };
    return {
      keyframes: [
        { opacity: 0, transform: 'translate3d(0, -48px, 0) scale(0.82)' },
        { opacity: 1, transform: 'translate3d(0, 4px, 0) scale(1.04)', offset: 0.62 },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
      ],
      options: { duration: t.duration.enter * 1.9, easing: t.easing.out, fill: 'both' },
    };
  },
  /** Самоцвет режима: поворот и «вспышка» масштаба чуть позже плиты */
  modeIcon(t: HudTheme, reduced: boolean): MotionPreset | null {
    if (reduced) return null;
    return {
      keyframes: [
        { transform: 'rotate(-40deg) scale(0.3)', opacity: 0 },
        { transform: 'rotate(8deg) scale(1.18)', opacity: 1, offset: 0.65 },
        { transform: 'rotate(0deg) scale(1)', opacity: 1 },
      ],
      options: { duration: t.duration.enter * 2.2, delay: t.duration.enter * 0.5, easing: t.easing.out, fill: 'both' },
    };
  },
  /** Турбо: две «вспышки» самоцвета после появления */
  modeCharge(t: HudTheme, reduced: boolean): MotionPreset | null {
    if (reduced) return null;
    return { keyframes: [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], options: { duration: 420, delay: t.duration.enter * 3, iterations: 2, easing: 'ease-in-out' } };
  },
  /** Блик по плите слева направо */
  modeSweep(t: HudTheme, reduced: boolean): MotionPreset | null {
    if (reduced) return null;
    return {
      keyframes: [{ transform: 'translate3d(-120%, 0, 0)' }, { transform: 'translate3d(320%, 0, 0)' }],
      options: { duration: 950, delay: t.duration.enter * 1.2, easing: t.easing.inOut, fill: 'both' },
    };
  },
  /** Уход вверх */
  modeExit(t: HudTheme, reduced: boolean): MotionPreset {
    if (reduced) return { keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 120, easing: 'linear', fill: 'both' } };
    return {
      keyframes: [
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
        { opacity: 0, transform: 'translate3d(0, -28px, 0) scale(0.96)' },
      ],
      options: { duration: t.duration.exit * 1.6, easing: t.easing.in, fill: 'both' },
    };
  },
  /** Текст обновился (ИИ дописал) — короткое проявление */
  update(t: HudTheme, reduced: boolean): MotionPreset | null {
    if (reduced) return null;
    return { keyframes: [{ opacity: 0.3 }, { opacity: 1 }], options: { duration: t.duration.update, easing: t.easing.out } };
  },
};

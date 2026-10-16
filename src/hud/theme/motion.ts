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
  /** Текст обновился (ИИ дописал) — короткое проявление */
  update(t: HudTheme, reduced: boolean): MotionPreset | null {
    if (reduced) return null;
    return { keyframes: [{ opacity: 0.3 }, { opacity: 1 }], options: { duration: t.duration.update, easing: t.easing.out } };
  },
};

// Собственный OCR для цифр HUD: сравнение символов с шаблонами, собранными из размеченных кадров.
// Шрифт интерфейса Dota фиксирован, поэтому сравнение с образцами точнее и в сотни раз быстрее
// универсального OCR. Если символ не похож ни на один образец — уверенность низкая, значение отбрасывается.
import { GLYPH_H, GLYPH_W, segment, type Glyph, type SegmentOptions } from '../vision/segment.ts';
import type { RgbaImage } from '../vision/image.ts';
import type { Rect } from '../../shared/types/observation.ts';

export interface GlyphSample {
  ch: string;
  vec: number[];
  aspect: number;
  relH: number;
  relTop: number;
  /** откуда взят образец — для отслеживаемости */
  source: string;
}

export interface GlyphModel {
  version: 1;
  grid: [number, number];
  trainedAt: string;
  samples: GlyphSample[];
}

export interface ReadGlyph {
  ch: string;
  score: number;
  margin: number;
  box: Rect;
}

export interface ReadResult {
  text: string;
  glyphs: ReadGlyph[];
  /** 0..1 — уверенность всей строки (по самому сомнительному символу) */
  confidence: number;
  hasText: boolean;
  /** символ обрезан краем области — значение нельзя использовать */
  truncated: boolean;
}

/** Расстояние между символом и образцом: форма + пропорции + положение в строке */
export function glyphDistance(g: Pick<Glyph, 'vec' | 'aspect' | 'relH' | 'relTop'>, s: GlyphSample): number {
  let d = 0;
  for (let i = 0; i < g.vec.length; i++) d += (g.vec[i]! - s.vec[i]!) ** 2;
  d /= g.vec.length;
  return d + 0.05 * (g.aspect - s.aspect) ** 2 + 0.1 * (g.relH - s.relH) ** 2 + 0.1 * (g.relTop - s.relTop) ** 2;
}

/**
 * Калибровка (по кадрам второй записи, не участвовавшим в обучении, 2026-10-11):
 * расстояние до верного символа — p95 0.075, максимум 0.105; до ближайшего неверного — минимум 0.089.
 * Расстояние больше MAX_DIST означает «на образцы не похоже» — такой символ считаем нераспознанным.
 */
const MAX_DIST = 0.25;

export function classify(model: GlyphModel, g: Glyph): { ch: string; score: number; margin: number } {
  let best = Infinity, bestCh = '?';
  const perChar = new Map<string, number>();
  for (const s of model.samples) {
    const d = glyphDistance(g, s);
    if (d < (perChar.get(s.ch) ?? Infinity)) perChar.set(s.ch, d);
    if (d < best) {
      best = d;
      bestCh = s.ch;
    }
  }
  let second = Infinity;
  for (const [ch, d] of perChar) if (ch !== bestCh && d < second) second = d;
  // margin: насколько лучший вариант лучше ближайшего другого символа (0 — неразличимы, 1 — явно)
  const margin = Number.isFinite(second) ? Math.max(0, Math.min(1, 1 - best / Math.max(second, 1e-9))) : 1;
  // Уверенность: главное — отрыв от второго варианта; плюс штраф, если символ вообще не похож на образцы
  const likeness = Math.max(0, 1 - best / MAX_DIST);
  const score = Math.min(Math.sqrt(margin), likeness);
  return { ch: bestCh, score, margin };
}

export function readText(model: GlyphModel, img: RgbaImage, opts: SegmentOptions): ReadResult {
  if (model.grid[0] !== GLYPH_W || model.grid[1] !== GLYPH_H) throw new Error('Модель символов не совпадает с сеткой');
  const seg = segment(img, opts);
  if (!seg.hasText) return { text: '', glyphs: [], confidence: 0, hasText: false, truncated: false };
  const glyphs = seg.glyphs.map((g) => ({ ...classify(model, g), box: g.box }));
  const confidence = seg.truncated ? 0 : Math.min(...glyphs.map((g) => g.score));
  return { text: glyphs.map((g) => g.ch).join(''), glyphs, confidence, hasText: true, truncated: seg.truncated };
}

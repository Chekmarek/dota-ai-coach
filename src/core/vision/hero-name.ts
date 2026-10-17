// Распознавание имени героя над портретом нижней панели.
// Буквы сравниваются с образцами, а итог выбирается только из известных имён героев (127 штук):
// учитываются число слов, длина каждого слова и форма букв. Для букв, которых ещё нет в образцах,
// ставится нейтральная «цена» — поэтому имя узнаётся и по части букв, а при неоднозначности — не узнаётся.
import type { Observed, Rect } from '../../shared/types/observation.ts';
import { glyphDistance, type GlyphModel } from '../ocr/glyph-ocr.ts';
import { segment, type Glyph } from './segment.ts';
import type { ChannelMode, FrameAccess } from './image.ts';
import { legacyGeometry, type HudGeometry } from './hud-geometry.ts';

export interface HeroNameEntry {
  id: number;
  key: string;
  name: string;
}

export interface HeroIdentity {
  id: number;
  name: string;
}

/** Центр имени — на 91 px левее края полосы маны (1920×1080), проверено на Kez, Shadow Fiend, Monkey King, Morphling */
const NAME_CENTER_FROM_BAR = -91;
const NAME_RECT = { w: 210, y: 917, h: 18 };
/**
 * Способы выделения букв. Последний — постоянный порог белизны min(R,G,B) > 200: Оцу ошибается, когда фон
 * местами ярок, как буквы (голубая вода, светлые камни). 200 выбран только по обучающим кадрам Hero Demo
 * 2026-10-17 (плато 200–205: 26 из 31 узнано, неверных 0; у 180 — 17, у 220 — 21).
 */
export const NAME_PASSES: { mode: ChannelMode; threshold?: number }[] = [{ mode: 'luma' }, { mode: 'white' }, { mode: 'saturation' }, { mode: 'white', threshold: 200 }];
/** Цена буквы, для которой нет образцов. Калибровка: верная буква ~0.00–0.06, неверная ≥ 0.09 */
const UNKNOWN_LETTER_COST = 0.075;
/** Средняя цена выше этой — имя на найденные буквы не похоже */
const MAX_MEAN_COST = 0.07;

export function heroNameRect(frameW: number, frameH: number, barLeft: number, geo: HudGeometry = legacyGeometry(frameW, frameH)): Rect {
  const s = geo.s, sy = geo.sy;
  const cx = barLeft + NAME_CENTER_FROM_BAR * s;
  return { x: Math.round(cx - (NAME_RECT.w / 2) * s), y: Math.round(geo.y(NAME_RECT.y)), w: Math.round(NAME_RECT.w * s), h: Math.round(NAME_RECT.h * sy) };
}

/**
 * Оставляет только буквы: все заглавные буквы имени одной высоты и стоят на одной линии.
 * Пятна фона, значки и обрывки другой высоты отбрасываются; relH/relTop пересчитываются по буквам.
 */
export function keepLetters(glyphs: Glyph[]): Glyph[] {
  const tall = glyphs.filter((g) => g.box.h >= 5);
  if (tall.length < 2) return [];
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  const h = median(tall.map((g) => g.box.h));
  const top = median(tall.map((g) => g.box.y));
  return glyphs
    .filter((g) => Math.abs(g.box.h - h) <= h * 0.2 + 1 && Math.abs(g.box.y - top) <= 2 && g.aspect <= 1.6)
    .map((g) => ({ ...g, relH: g.box.h / h, relTop: (g.box.y - top) / h }));
}

/** Делит символы на слова по промежуткам */
export function splitWords(glyphs: Glyph[]): Glyph[][] {
  if (!glyphs.length) return [];
  const lineH = Math.max(...glyphs.map((g) => g.box.h));
  const words: Glyph[][] = [[glyphs[0]!]];
  for (let i = 1; i < glyphs.length; i++) {
    const prev = glyphs[i - 1]!, g = glyphs[i]!;
    const gap = g.box.x - (prev.box.x + prev.box.w);
    if (gap > lineH * 0.6) words.push([g]);
    else words[words.length - 1]!.push(g);
  }
  return words;
}

interface Scored {
  entry: HeroNameEntry;
  cost: number;
}

/**
 * Как имя может разбиться на слова на экране. Дефис и апостроф — не буквы: keepLetters их отбрасывает,
 * а на их месте остаётся либо узкий промежуток (слово целое: ANTIMAGE, NATURES), либо широкий
 * (отдельные слова: ANTI MAGE, NATURE S) — проверено на кадрах Anti-Mage и Nature's Prophet 2026-10-17.
 */
export function nameWordVariants(name: string): string[][] {
  const upper = name.toUpperCase();
  const joined = upper.split(' ').map((w) => w.replace(/[^A-Z]/g, '')).filter(Boolean);
  const split = upper.split(/[^A-Z]+/).filter(Boolean);
  return joined.join(' ') === split.join(' ') ? [joined] : [joined, split];
}

/** Цена совпадения прочитанных слов с именем героя; null — не совпадает по форме (число слов/букв) */
export function nameCost(words: Glyph[][], name: string, model: GlyphModel): number | null {
  let best: number | null = null;
  for (const target of nameWordVariants(name)) {
    const cost = wordsCost(words, target, model);
    if (cost !== null && (best === null || cost < best)) best = cost;
  }
  return best;
}

function wordsCost(words: Glyph[][], target: string[], model: GlyphModel): number | null {
  if (target.length !== words.length) return null;
  let total = 0, n = 0;
  for (let w = 0; w < target.length; w++) {
    const letters = target[w]!, glyphs = words[w]!;
    if (letters.length !== glyphs.length) return null;
    for (let i = 0; i < letters.length; i++) {
      let best = Infinity;
      for (const s of model.samples) if (s.ch === letters[i]) best = Math.min(best, glyphDistance(glyphs[i]!, s));
      total += Number.isFinite(best) ? best : UNKNOWN_LETTER_COST;
      n++;
    }
  }
  return total / n;
}

export interface HeroNameResult {
  observed: Observed<HeroIdentity>;
  /** Для диагностики: лучшие кандидаты */
  candidates: { name: string; cost: number }[];
}

export function readHeroName(
  frame: FrameAccess,
  barLeft: number | null,
  model: GlyphModel,
  names: HeroNameEntry[],
  observedAt: number,
  layoutId: string,
  schemaVersion: string,
  geo: HudGeometry = legacyGeometry(frame.width, frame.height),
): HeroNameResult {
  const frameSize = { w: frame.width, h: frame.height };
  const rect = barLeft === null ? { x: 0, y: 0, w: 0, h: 0 } : heroNameRect(frame.width, frame.height, barLeft, geo);
  const base = { observedAt, sourceRegion: { layoutId, regionId: 'heroName', rect, frameSize }, schemaVersion };
  if (barLeft === null) return { observed: { ...base, value: null, confidence: 0, validity: 'absent', raw: '' }, candidates: [] };

  const region = frame.read(rect);
  let bestResult: HeroNameResult | null = null;
  for (const pass of NAME_PASSES) {
    const seg = segment(region, { ...pass, splitWide: false, minSeparation: 45, dropBorder: true });
    if (!seg.hasText) continue;
    const words = splitWords(keepLetters(seg.glyphs));
    const scored: Scored[] = [];
    for (const entry of names) {
      const cost = nameCost(words, entry.name, model);
      if (cost !== null) scored.push({ entry, cost });
    }
    scored.sort((a, b) => a.cost - b.cost);
    const raw = words.map((w) => w.length).join('+');
    const candidates = scored.slice(0, 3).map((s) => ({ name: s.entry.name, cost: Math.round(s.cost * 1000) / 1000 }));
    const best = scored[0];
    if (!best) {
      const r: HeroNameResult = { observed: { ...base, value: null, confidence: 0, validity: 'unparsed', raw: `слова ${raw}` }, candidates };
      bestResult ??= r;
      continue;
    }
    const second = scored[1]?.cost ?? Infinity;
    // Уверенность: насколько лучший вариант отрывается от второго + насколько он вообще похож
    const margin = Number.isFinite(second) ? Math.max(0, 1 - best.cost / second) : 1;
    const likeness = Math.max(0, 1 - best.cost / (MAX_MEAN_COST * 1.5));
    const confidence = Math.min(Math.sqrt(margin), likeness);
    const accepted = best.cost <= MAX_MEAN_COST && confidence >= 0.5;
    const r: HeroNameResult = {
      observed: {
        ...base,
        value: accepted ? { id: best.entry.id, name: best.entry.name } : null,
        confidence,
        validity: accepted ? 'valid' : 'unparsed',
        raw: `${best.entry.name} (${raw})`,
      },
      candidates,
    };
    if (!bestResult || (r.observed.value && !bestResult.observed.value) || (!!r.observed.value === !!bestResult.observed.value && r.observed.confidence > bestResult.observed.confidence)) bestResult = r;
    if (bestResult.observed.value && bestResult.observed.confidence >= 0.8) break;
  }
  return bestResult ?? { observed: { ...base, value: null, confidence: 0, validity: 'absent', raw: '' }, candidates: [] };
}

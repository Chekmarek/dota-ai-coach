import type { Observed } from '../../shared/types/observation.ts';
import { readText, type GlyphModel } from '../ocr/glyph-ocr.ts';
import type { FrameAccess } from './image.ts';
import { layoutFits, scaleRect, type HudLayout } from './hud-layout.ts';
import { HUD_FIELDS, PARSERS, type HudFieldId, type HudValues, type ParseResult } from './hud-fields.ts';
import { findBarAnchor, selectedUnitRelation, type UnitRelation } from './hud-anchors.ts';
import { readHeroName, type HeroIdentity, type HeroNameEntry } from './hero-name.ts';

/** Ниже этой уверенности распознанное значение не принимается (value = null) */
export const MIN_CONFIDENCE = 0.5;

export type HudObservations = { [K in HudFieldId]: Observed<HudValues[K]> };

export interface HudReading {
  layoutId: string;
  frameSize: { w: number; h: number };
  supported: boolean;
  fields: HudObservations;
  /**
   * Чья панель внизу: нижний HUD показывает ВЫБРАННОГО юнита. Если выбран враг (красная полоса HP) —
   * здоровье, мана и уровень относятся к нему, а не к герою игрока.
   */
  selectedUnit: Observed<UnitRelation>;
  /** Имя героя над портретом нижней панели (того юнита, что выбран) */
  heroName: Observed<HeroIdentity>;
  /** Лучшие кандидаты на имя — для диагностики */
  heroNameCandidates: { name: string; cost: number }[];
  durationMs: number;
}

export interface RecognizeOptions {
  /** Модель букв имени героя и список имён; без них имя не распознаётся */
  heroName?: { model: GlyphModel; names: HeroNameEntry[] };
  now?: () => number;
}

/**
 * Распознаёт видимые числа HUD на одном кадре.
 * Каждое значение — Observed: с уверенностью, областью-источником и статусом.
 * Ничего не «додумывает»: нет текста / не разобрано / неправдоподобно → value = null.
 */
export function recognizeHud(
  frame: FrameAccess,
  layout: HudLayout,
  model: GlyphModel,
  observedAt: number,
  opts: RecognizeOptions = {},
): HudReading {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const frameSize = { w: frame.width, h: frame.height };
  const supported = layoutFits(layout, frame.width, frame.height);
  const fields = {} as Record<HudFieldId, Observed<unknown>>;
  const anchor = supported ? findBarAnchor(frame) : { barLeft: null, confidence: 0 };
  const sx = frame.width / layout.reference.w;

  for (const id of HUD_FIELDS) {
    const def = layout.regions[id];
    if (!def) throw new Error(`В раскладке ${layout.id} нет области ${id}`);
    const rect = scaleRect(layout, def, frame.width, frame.height);
    if (def.anchor === 'barLeft' && anchor.barLeft !== null && layout.anchors?.barLeft !== undefined) {
      rect.x += anchor.barLeft - Math.round(layout.anchors.barLeft * sx);
    }
    const base = {
      observedAt,
      sourceRegion: { layoutId: layout.id, regionId: id, rect, frameSize },
      schemaVersion: layout.schemaVersion,
    };
    if (!supported) {
      fields[id] = { ...base, value: null, confidence: 0, validity: 'unsupported', raw: '' };
      continue;
    }
    if (def.anchor && anchor.barLeft === null) {
      // Положение элемента зависит от ширины панели, а опора не найдена — не читаем «наугад»
      fields[id] = { ...base, value: null, confidence: 0, validity: 'absent', raw: '' };
      continue;
    }
    const region = frame.read(rect);
    const parse = PARSERS[id] as (t: string) => ParseResult<unknown>;
    // Пробуем основной и запасные способы выделения текста; берём самый уверенный разобранный результат
    let best: Observed<unknown> | null = null;
    for (const mode of [def.mode, ...(def.altModes ?? [])]) {
      const read = readText(model, region, { mode, dropBorder: def.dropBorder, circleMask: def.circleMask, firstRun: def.firstRun });
      let o: Observed<unknown>;
      if (!read.hasText) o = { ...base, value: null, confidence: 0, validity: 'absent', raw: '' };
      else if (read.truncated) o = { ...base, value: null, confidence: 0, validity: 'unparsed', raw: read.text };
      else {
        const parsed = parse(read.text);
        if (!parsed.ok) o = { ...base, value: null, confidence: read.confidence, validity: parsed.reason, raw: read.text };
        else {
          const accepted = read.confidence >= MIN_CONFIDENCE;
          o = { ...base, value: accepted ? parsed.value : null, confidence: read.confidence, validity: accepted ? 'valid' : 'unparsed', raw: read.text };
        }
      }
      if (!best || rank(o) > rank(best)) best = o;
      if (best.validity === 'valid' && best.confidence >= 0.8) break;
    }
    fields[id] = best!;
  }

  // Чей юнит выбран — по цвету полосы здоровья
  const relRect = { x: anchor.barLeft ?? 0, y: Math.round(1024 * (frame.height / layout.reference.h)), w: Math.round(44 * sx), h: Math.round(12 * sx) };
  const relBase = {
    observedAt,
    sourceRegion: { layoutId: layout.id, regionId: 'selectedUnit', rect: relRect, frameSize },
    schemaVersion: layout.schemaVersion,
    raw: '',
  };
  let selectedUnit: Observed<UnitRelation>;
  if (!supported) selectedUnit = { ...relBase, value: null, confidence: 0, validity: 'unsupported' };
  else if (anchor.barLeft === null) selectedUnit = { ...relBase, value: null, confidence: 0, validity: 'absent' };
  else {
    const rel = selectedUnitRelation(frame, anchor.barLeft);
    selectedUnit = { ...relBase, value: rel.value, confidence: rel.confidence, validity: rel.value ? 'valid' : 'absent', raw: rel.value ?? '' };
  }

  // Имя героя над портретом (позиция тоже зависит от ширины панели)
  const name =
    supported && opts.heroName
      ? readHeroName(frame, anchor.barLeft, opts.heroName.model, opts.heroName.names, observedAt, layout.id, layout.schemaVersion)
      : {
          observed: {
            observedAt,
            sourceRegion: { layoutId: layout.id, regionId: 'heroName', rect: { x: 0, y: 0, w: 0, h: 0 }, frameSize },
            schemaVersion: layout.schemaVersion,
            value: null,
            confidence: 0,
            validity: supported ? ('absent' as const) : ('unsupported' as const),
            raw: '',
          },
          candidates: [],
        };

  return {
    layoutId: layout.id,
    frameSize,
    supported,
    fields: fields as HudObservations,
    selectedUnit,
    heroName: name.observed,
    heroNameCandidates: name.candidates,
    durationMs: now() - t0,
  };
}

/** Сравнение результатов: принятое значение лучше отклонённого, затем — по уверенности */
function rank(o: Observed<unknown>): number {
  return (o.validity === 'valid' ? 2 : o.raw ? 1 : 0) + o.confidence;
}

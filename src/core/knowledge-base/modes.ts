// Механика карты по режиму игры (0.13.3): Турбо — те же записи mechanics.json, но с отличиями из
// src/data/modes/turbo.json. У каждой записи справочника есть статус: same — как в обычной игре, changed — свои
// значения (остальные ключи как обычно), unknown — в Турбо не проверено: все значения null и verification «missing»,
// поэтому таймеры показывают «нет данных», а правила, которым нужно значение, молчат. Обычный режим не меняется.
// Чистое ядро: только zod, без Electron, DOM, сети и файлов.
import { z } from 'zod';
import type { MechanicsEntry } from '../../shared/types/mechanics.ts';

const sourceSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  /** Ревизия страницы вики, по которой сверено; null — у источника ревизий нет */
  revision: z.number().int().positive().nullable(),
  license: z.string().nullable(),
});

const entrySchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['same', 'changed', 'unknown']),
    /** stated — так написано в источнике; derived — посчитано из обычного значения по правилу источника (×2, ÷2);
     *  not-listed — в списке отличий Турбо нет; conflict — источники расходятся или молчат */
    basis: z.enum(['stated', 'derived', 'not-listed', 'conflict']),
    sources: z.array(z.string().min(1)),
    noteRu: z.string().min(1),
    values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
    schedule: z.object({ firstAt: z.number().nullable(), interval: z.number().positive().nullable(), lastAt: z.number().nullable() }).optional(),
  })
  .strict();

const ruleSchema = z.object({ value: z.unknown(), sources: z.array(z.string().min(1)).min(1), noteRu: z.string().min(1) });

export const modeOverridesSchema = z.object({
  schema: z.literal('dota-coach.mode-overrides'),
  version: z.literal(1),
  mode: z.literal('turbo'),
  /** Патч базы знаний, с которой сверены отличия */
  patch: z.string().min(1),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  noteRu: z.string(),
  sources: z.record(z.string(), sourceSchema),
  entries: z.array(entrySchema),
  rules: z.record(z.string(), ruleSchema),
});

export type ModeOverrides = z.infer<typeof modeOverridesSchema>;
export type ModeOverrideEntry = z.infer<typeof entrySchema>;

/** Справочник Турбо: неверная форма — null (тогда механика Турбо целиком «не проверено») */
export function parseModeOverrides(raw: unknown): ModeOverrides | null {
  const r = modeOverridesSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Механика для Турбо. Нет справочника или он для другого патча — каждая запись «в Турбо не проверено»:
 * значение, не сверенное для этого патча, не показывается как уверенное.
 */
export function turboMechanics(entries: readonly MechanicsEntry[], overrides: ModeOverrides | null, kbPatch: string | null): MechanicsEntry[] {
  const valid = overrides && kbPatch !== null && overrides.patch === kbPatch ? overrides : null;
  const byId = new Map((valid?.entries ?? []).map((o) => [o.id, o]));
  return entries.map((e) => {
    const o = byId.get(e.id);
    if (!o || o.status === 'unknown') {
      const why = o ? o.noteRu : valid ? 'записи нет в справочнике Турбо' : 'справочник Турбо не сверен с этим патчем';
      return { ...e, values: e.values.map((v) => ({ ...v, value: null })), schedule: null, notesRu: `В Турбо не проверено: ${why}`, verification: 'missing' };
    }
    if (o.status === 'same') return e;
    const src = valid!.sources[o.sources[0]!];
    return {
      ...e,
      values: e.values.map((v) => (o.values && v.key in o.values ? { ...v, value: o.values[v.key]! } : v)),
      schedule: o.schedule !== undefined ? o.schedule : (e.schedule ?? null),
      notesRu: `Турбо: ${o.noteRu}`,
      source: src ? { name: src.name, url: src.url, license: src.license } : e.source,
      retrievedAt: valid!.verifiedAt,
      // Значения Турбо — из вики и гайдов, а не из данных Valve: «проверено» не ставим
      verification: e.verification === 'missing' ? 'missing' : 'imported-unverified',
    };
  });
}

/** Число из правил справочника (aegisSec и т. п.); null — нет справочника или правила */
export function modeRule(overrides: ModeOverrides | null, key: string): number | null {
  const v = overrides?.rules[key]?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

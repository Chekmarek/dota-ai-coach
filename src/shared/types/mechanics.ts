import { z } from 'zod';

// Механика карты: формат файла resources/data/kb/<патч>/mechanics.json (собирает scripts/import-kb.mjs).
// Схема терпимая: лишние поля допустимы, плохая запись отбрасывается с предупреждением, а не весь файл.

export const MECHANICS_VERIFICATION = ['verified', 'imported-unverified', 'missing'] as const;
export type MechanicsVerification = (typeof MECHANICS_VERIFICATION)[number];

/** Порядок и подписи категорий для интерфейса */
export const MECHANICS_CATEGORIES: { id: string; nameRu: string }[] = [
  { id: 'lane-creeps', nameRu: 'Крипы на линиях' },
  { id: 'neutral-camps', nameRu: 'Лагеря нейтралов' },
  { id: 'runes', nameRu: 'Руны и пруды с лотосами' },
  { id: 'day-night', nameRu: 'День и ночь' },
  { id: 'roshan', nameRu: 'Рошан' },
  { id: 'tormentor', nameRu: 'Мучитель' },
  { id: 'neutral-items', nameRu: 'Нейтральные предметы' },
  { id: 'buyback-respawn-xp', nameRu: 'Выкуп, возрождение, опыт' },
  { id: 'gold', nameRu: 'Золото' },
  { id: 'glyph-scan-courier-wards', nameRu: 'Глиф, скан, курьер, варды' },
  { id: 'buildings', nameRu: 'Здания' },
  { id: 'map-objects', nameRu: 'Объекты карты' },
];

const valueSchema = z.object({
  key: z.string().min(1),
  labelRu: z.string().min(1),
  /** null — значения нет ни в одном источнике (не заполняется по памяти) */
  value: z.union([z.number(), z.string(), z.null()]),
  unit: z.string().nullable().optional(),
});

/** Расписание в секундах игрового времени (0 — горн). interval null — событие не повторяется само */
const scheduleSchema = z.object({
  firstAt: z.number().nullable(),
  interval: z.number().positive().nullable(),
  lastAt: z.number().nullable(),
});

const sourceSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  license: z.string().nullable().optional(),
});

export const mechanicsEntrySchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    nameRu: z.string().min(1),
    values: z.array(valueSchema).min(1),
    schedule: scheduleSchema.nullable().optional(),
    notesRu: z.string(),
    source: sourceSchema,
    /** Патч, для которого значение подтверждено источником (у вики — последняя правка в истории изменений); null — не указан */
    patch: z.string().nullable(),
    retrievedAt: z.string().min(1),
    verification: z.enum(MECHANICS_VERIFICATION),
  })
  .refine((e) => e.verification !== 'missing' || e.values.every((v) => v.value === null), {
    message: 'у записи «missing» все значения должны быть null',
  });

export type MechanicsValue = z.infer<typeof valueSchema>;
export type MechanicsSchedule = z.infer<typeof scheduleSchema>;
export type MechanicsEntry = z.infer<typeof mechanicsEntrySchema>;

export interface MechanicsFile {
  patch: string;
  generatedAt: string;
  entries: MechanicsEntry[];
}

const fileSchema = z.object({
  patch: z.string().min(1),
  generatedAt: z.string().min(1),
  entries: z.array(z.unknown()),
});

/**
 * Разбор mechanics.json. Файл целиком отклоняется, только если нет патча, даты или списка записей;
 * отдельная плохая запись (или повтор id) отбрасывается с предупреждением.
 */
export function parseMechanics(raw: unknown): { file: MechanicsFile | null; warnings: string[] } {
  const top = fileSchema.safeParse(raw);
  if (!top.success) return { file: null, warnings: [`mechanics.json: неверный формат файла (${top.error.issues[0]?.message ?? 'ошибка'})`] };
  const warnings: string[] = [];
  const entries: MechanicsEntry[] = [];
  const seen = new Set<string>();
  top.data.entries.forEach((e, i) => {
    const r = mechanicsEntrySchema.safeParse(e);
    const id = typeof (e as { id?: unknown })?.id === 'string' ? (e as { id: string }).id : `#${i}`;
    if (!r.success) {
      warnings.push(`mechanics.json: запись ${id} отброшена (${r.error.issues.map((x) => `${x.path.join('.') || '—'}: ${x.message}`).join('; ')})`);
      return;
    }
    if (seen.has(r.data.id)) {
      warnings.push(`mechanics.json: повтор id ${r.data.id} — оставлена первая запись`);
      return;
    }
    seen.add(r.data.id);
    entries.push(r.data);
  });
  return { file: { patch: top.data.patch, generatedAt: top.data.generatedAt, entries }, warnings };
}

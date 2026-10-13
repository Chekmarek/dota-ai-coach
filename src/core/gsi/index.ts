// Valve Game State Integration (GSI) — главный источник данных о матче (решение 2026-10-13, docs/POLICY.md).
// Ядро: схема тела запроса, перевод в чтение коуча, сверка со зрением и разметка кадров.
// Приём HTTP-запросов и запись конфигурации в папку Dota — не здесь (этап 2, процесс main).
export {
  parseGsiBody,
  gsiBodySchema,
  gsiProviderSchema,
  gsiMapSchema,
  gsiPlayerSchema,
  gsiHeroSchema,
  gsiAbilitySchema,
  gsiItemSchema,
  type GsiBody,
  type GsiAbilityRaw,
  type GsiItemRaw,
  type GsiParseResult,
} from './schema.ts';
export { mapGsi, gsiPhase, gsiSlotName, type GsiReading, type GsiAbility, type GsiItemSlot, type GsiPhase, type ItemNameLookup, type HeroLookup } from './map.ts';
export { AgreementTracker, AGREE_WINDOW_MS, POOL_TOLERANCE, CLOCK_TOLERANCE_SEC, type AgreementField, type AgreementReport, type FieldAgreement } from './agreement.ts';
export { labelFromGsi, type HudFrameLabel } from './labels.ts';

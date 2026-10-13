// Разметка кадра из GSI — в том же виде, что ручная разметка кадров tests/fixtures/hud/labels.json:
// { file, split, selectedUnit, fields: { gameClock: "20:02", health: "1530/1616", kda: "10/3/4", ... } }.
// Так кадры живой игры размечаются автоматически: снимок экрана + GSI того же момента.
// Чистое ядро: без Electron, DOM, сети и файлов.
import { HUD_FIELDS, formatHudLabel, type HudFieldId, type HudValues } from '../vision/hud-fields.ts';
import type { GsiReading } from './map.ts';

export interface HudFrameLabel {
  file?: string;
  split?: 'train' | 'test';
  /**
   * Чей юнит на нижней панели. GSI сообщает только своего героя, поэтому разметка верна для панели,
   * лишь когда выбран свой герой: кадры с выбранным чужим юнитом размечать этой функцией нельзя.
   */
  selectedUnit: 'ally';
  /** Только поля, которые GSI сообщил; формат — formatHudLabel */
  fields: Partial<Record<HudFieldId, string>>;
  /** Отсчёт до горна (время отрицательное) — как в разметке игры 4 */
  preHorn?: boolean;
}

/** Значения GSI в типах полей HUD; null — GSI поле не сообщил */
function values(r: GsiReading): { [K in HudFieldId]: HudValues[K] | null } {
  return {
    gameClock: r.clock,
    scoreRadiant: r.scoreRadiant,
    scoreDire: r.scoreDire,
    gold: r.gold,
    health: r.hero.health,
    mana: r.hero.mana,
    level: r.hero.level,
    kda: r.kda,
    farm: r.farm,
  };
}

export function labelFromGsi(reading: GsiReading, meta: { file?: string; split?: 'train' | 'test' } = {}): HudFrameLabel {
  const v = values(reading);
  const fields: Partial<Record<HudFieldId, string>> = {};
  for (const id of HUD_FIELDS) {
    const x = v[id];
    if (x !== null) fields[id] = formatHudLabel(id, x);
  }
  const label: HudFrameLabel = { ...meta, selectedUnit: 'ally', fields };
  if (reading.clock !== null && reading.clock < 0) label.preHorn = true;
  return label;
}

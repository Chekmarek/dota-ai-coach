// Сверка зрения о союзниках и врагах с GSI наблюдателя (этап 4 зрения).
// Когда Dota присылает GSI в режиме наблюдателя (просмотр записи или трансляции), в нём есть все 10 героев:
// герой, жив ли, где стоит, здоровье и уровень. Это эталон для верхней панели, мини-карты и полосок здоровья.
// У игрока такого GSI нет (только свой герой) — тогда эти строки «Точности зрения» просто не появляются.
// Чтение с экрана сравнивается с чтениями GSI не старше VISION_AGREE_WINDOW_MS: верно, если совпало хоть с одним
// (герой мог сдвинуться между кадром и запросом GSI). Чистое ядро: без Electron, DOM, сети и файлов.
import type { HudReading } from '../vision/recognize-hud.ts';
import { barTeam } from '../vision/health-bars.ts';
import type { SpectatorHero, SpectatorReading } from './spectator.ts';
import type { FieldAgreement } from './agreement.ts';

/** Чтения GSI наблюдателя не старше этого (мс) годятся для сравнения с кадром */
export const VISION_AGREE_WINDOW_MS = 1000;
/** Значок на мини-карте верен, если до героя по GSI не дальше этого (единицы мира) — порог этапа 2 */
export const MINIMAP_POSITION_TOLERANCE = 400;
/** Здоровье с полоски верно, если отличается от GSI не больше чем на столько процентных пунктов — порог этапа 3 */
export const HEALTH_BAR_TOLERANCE_PP = 5;

export type VisionAgreementField = 'topBarHero' | 'topBarAlive' | 'minimapPosition' | 'healthBarHp';
export type VisionAgreementReport = Partial<Record<VisionAgreementField, FieldAgreement>>;

interface Check {
  field: VisionAgreementField;
  screen: unknown;
  /** Значение GSI из одного чтения (null — в нём нет) и совпадает ли оно с экраном */
  gsi: (heroes: SpectatorHero[]) => unknown;
  match: (gsi: unknown) => boolean;
}

export class VisionAgreementTracker {
  private readings: { wallMs: number; heroes: SpectatorHero[] }[] = [];
  private stats = new Map<VisionAgreementField, { samples: number; agree: number; lastMismatch: FieldAgreement['lastMismatch'] }>();

  /** Чтение GSI наблюдателя (без героев — не наблюдатель, ничего не делаем) */
  addSpectator(r: SpectatorReading | null, wallMs: number): void {
    if (!r || r.heroes.length === 0) return;
    this.readings.push({ wallMs, heroes: r.heroes });
    this.readings = this.readings.filter((x) => wallMs - x.wallMs <= VISION_AGREE_WINDOW_MS);
  }

  /** Кадр: сравнивается с чтениями GSI наблюдателя за последние VISION_AGREE_WINDOW_MS */
  addScreen(hud: HudReading, wallMs: number): void {
    const around = this.readings.filter((x) => x.wallMs <= wallMs + 50 && wallMs - x.wallMs <= VISION_AGREE_WINDOW_MS);
    if (around.length === 0) return;
    for (const c of checksOf(hud, around[around.length - 1]!.heroes)) {
      let nearest: unknown = null, agreed = false;
      for (let i = around.length - 1; i >= 0; i--) {
        const v = c.gsi(around[i]!.heroes);
        if (v === null || v === undefined) continue;
        if (nearest === null) nearest = v;
        if (c.match(v)) agreed = true;
      }
      if (nearest === null) continue;
      const st = this.stats.get(c.field) ?? { samples: 0, agree: 0, lastMismatch: null };
      st.samples++;
      if (agreed) st.agree++;
      else st.lastMismatch = { gsi: nearest, screen: c.screen, wallMs };
      this.stats.set(c.field, st);
    }
  }

  report(): VisionAgreementReport {
    const out: VisionAgreementReport = {};
    for (const [f, s] of this.stats) out[f] = { samples: s.samples, agreePct: s.samples ? Math.round((s.agree / s.samples) * 1000) / 10 : null, lastMismatch: s.lastMismatch };
    return out;
  }

  reset(): void {
    this.readings = [];
    this.stats.clear();
  }
}

const bySlot = (heroes: SpectatorHero[], slot: number) => heroes.find((h) => h.slot === slot) ?? null;

/** Что с этого кадра можно сравнить. latest — свежее чтение GSI: по нему решается, чья полоска здоровья */
function checksOf(hud: HudReading, latest: SpectatorHero[]): Check[] {
  const out: Check[] = [];
  if (hud.topBar?.supported) {
    for (const s of hud.topBar.slots) {
      if (s.heroKey !== null)
        out.push({ field: 'topBarHero', screen: s.heroKey, gsi: (hs) => bySlot(hs, s.slot)?.heroKey ?? null, match: (g) => g === s.heroKey });
      if (s.alive !== null) out.push({ field: 'topBarAlive', screen: s.alive, gsi: (hs) => bySlot(hs, s.slot)?.alive ?? null, match: (g) => g === s.alive });
    }
  }
  if (hud.minimap?.supported) {
    for (const h of hud.minimap.heroes) {
      // Иллюзии и клоны: какой значок герой — не определить, такие не сравниваем
      if (h.ambiguous) continue;
      const pos = (hs: SpectatorHero[]) => {
        const g = bySlot(hs, h.slot);
        return g && g.alive !== false && g.xpos !== null && g.ypos !== null ? { x: g.xpos, y: g.ypos } : null;
      };
      out.push({
        field: 'minimapPosition',
        screen: { x: Math.round(h.x), y: Math.round(h.y) },
        gsi: pos,
        match: (g) => Math.hypot((g as { x: number }).x - h.x, (g as { y: number }).y - h.y) <= MINIMAP_POSITION_TOLERANCE,
      });
    }
  }
  if (hud.healthBars?.supported) {
    for (const b of hud.healthBars.bars) {
      if (b.level === null) continue;
      // Чья полоска — только если её цвет и уровень совпадают ровно с одним живым героем и полоска такая одна
      const team = barTeam(b.color, null);
      const cands = latest.filter((h) => h.alive !== false && h.team === team && h.level === b.level);
      const twins = hud.healthBars.bars.filter((o) => o.color === b.color && o.level === b.level).length;
      if (cands.length !== 1 || twins !== 1) continue;
      const slot = cands[0]!.slot;
      const hp = (hs: SpectatorHero[]) => {
        const g = bySlot(hs, slot);
        return g && g.health !== null && g.maxHealth ? Math.round((100 * g.health) / g.maxHealth) : null;
      };
      out.push({ field: 'healthBarHp', screen: b.hpPercent, gsi: hp, match: (g) => Math.abs((g as number) - b.hpPercent) <= HEALTH_BAR_TOLERANCE_PP });
    }
  }
  return out;
}

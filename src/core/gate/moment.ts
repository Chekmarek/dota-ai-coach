// Фильтр внимания: драка или спокойный момент. Данные игры (GSI) и зрение дополняют друг друга:
//  - GSI видит своё: здоровье падает, оглушён/заглушён, нажата способность, мёртв, на базе, пауза — но не видит врагов;
//  - зрение видит врагов рядом и вплотную — но может ошибаться и пропадать.
// Драка: оглушён; здоровье резко падает; враги вплотную и при этом урон или нажатая способность; драка по зрению
// с 2+ врагами рядом. Держится stressHoldMs после последнего признака. Спокойно: мёртв, пауза, до горна, на базе,
// идёт к базе без урона, или quietAfterMs без признаков драки и без врагов вплотную. Чистое ядро.
import type { GateConfig, GateMoment, GateSignals } from './types.ts';

/** Резкое падение здоровья: столько процентных пунктов за HP_WINDOW_MS — драка без всяких врагов на экране */
export const HP_DROP_FIGHT = 8;
/** Малое падение (урон по герою) — драка, только если враги вплотную */
export const HP_DROP_DAMAGE = 3;
export const HP_WINDOW_MS = 3000;
/** Шаг к базе, после которого игрок «идёт на базу» (ед. за 3 с) */
const RETREAT_UNITS = 300;

export class MomentTracker {
  private hp: { ms: number; pct: number }[] = [];
  private base: { ms: number; d: number }[] = [];
  private prevCd: (number | null)[] | null = null;
  private lastStressMs = -Infinity;
  private lastWhy: string[] = [];

  constructor(private readonly cfg: Pick<GateConfig, 'stressHoldMs' | 'quietAfterMs'>) {}

  reset(): void {
    this.hp = [];
    this.base = [];
    this.prevCd = null;
    this.lastStressMs = -Infinity;
    this.lastWhy = [];
  }

  /** Падение здоровья за последние HP_WINDOW_MS, п.п. (0 — не падало или не известно) */
  hpDrop(): number {
    if (this.hp.length < 2) return 0;
    const last = this.hp[this.hp.length - 1]!;
    const max = Math.max(...this.hp.map((x) => x.pct));
    return Math.max(0, max - last.pct);
  }

  update(s: GateSignals): GateMoment {
    const now = s.nowMs;
    if (s.alive === false || !s.inGame) {
      this.hp = [];
      this.base = [];
      this.prevCd = null;
    }
    if (s.hpPct !== null && s.alive !== false) this.hp.push({ ms: now, pct: s.hpPct });
    this.hp = this.hp.filter((x) => now - x.ms <= HP_WINDOW_MS);
    if (s.distToBase !== null) this.base.push({ ms: now, d: s.distToBase });
    this.base = this.base.filter((x) => now - x.ms <= 3000);

    // Нажатая способность: перезарядка была 0 и стала больше 0
    let cast = false;
    if (s.abilityCooldowns && this.prevCd && this.prevCd.length === s.abilityCooldowns.length) {
      cast = s.abilityCooldowns.some((c, i) => (c ?? 0) > 0 && (this.prevCd![i] ?? 0) === 0);
    }
    this.prevCd = s.abilityCooldowns ? [...s.abilityCooldowns] : null;

    const drop = this.hpDrop();
    const why: string[] = [];
    if (s.alive !== false && s.inGame && !s.paused) {
      if (s.disabled) why.push('оглушён или заглушён');
      if (drop >= HP_DROP_FIGHT) why.push(`здоровье −${Math.round(drop)}% за 3 с`);
      if ((s.enemiesClose ?? 0) > 0 && (drop >= HP_DROP_DAMAGE || cast)) why.push(cast ? 'враг вплотную, нажата способность' : 'враг вплотную, получаете урон');
      if (s.visionFight && (s.enemiesNear ?? 0) >= 2) why.push(`драка по зрению: ${s.enemiesNear} врага рядом`);
    }
    if (why.length) {
      this.lastStressMs = now;
      this.lastWhy = why;
    }
    const fight = s.alive !== false && s.inGame && !s.paused && now - this.lastStressMs < this.cfg.stressHoldMs;

    let calm: GateMoment['calm'] = null;
    if (!fight) {
      if (s.paused) calm = 'paused';
      else if (s.preGame) calm = 'pregame';
      else if (s.alive === false) calm = 'dead';
      else if (s.atBase) calm = 'base';
      else if (now - this.lastStressMs >= this.cfg.quietAfterMs && drop < HP_DROP_DAMAGE) {
        const first = this.base[0];
        const retreating = first !== undefined && s.distToBase !== null && first.d - s.distToBase >= RETREAT_UNITS && (s.enemiesNear ?? 0) === 0;
        if (retreating) calm = 'retreating';
        else if ((s.enemiesClose ?? 0) === 0) calm = 'quiet';
      }
    }
    return { fight, calm, why: fight ? this.lastWhy : [] };
  }
}

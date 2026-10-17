// Страница «Драфт» в main: считает подбор героя и угрозы по базе знаний и статистике патча.
// Без Electron: зависимости передаются снаружи (проверяется unit-тестами).
import { CoachLookup, type CoachData } from '@core/coach/data.ts';
import { counterDelta, counterItems, enemyThreats, itemRole, suggestHeroes, synergyDelta, type DraftReason } from '@core/draft/index.ts';
import type { CoachView } from '@core/coach/view.ts';
import type { KnowledgeBase } from '@shared/types/kb';
import type { KbStats } from '@shared/types/stats';
import type { DraftLiveHeroes, DraftReasonView, DraftRequest, DraftResult } from '@shared/types/draft';

export class DraftService {
  private look: CoachLookup | null = null;
  private error: string | null = null;

  constructor(private readonly kb: { get(): KnowledgeBase | { error: string }; stats(): KbStats | null }) {}

  private lookup(): CoachLookup | null {
    if (this.look || this.error) return this.look;
    const kb = this.kb.get();
    if ('error' in kb) {
      this.error = kb.error;
      return null;
    }
    const data: CoachData = { patch: kb.meta.patch, heroes: kb.heroes, items: kb.items, mechanics: kb.mechanics, stats: this.kb.stats(), kbVerified: kb.meta.verification === 'verified' };
    this.look = new CoachLookup(data);
    return this.look;
  }

  suggest(req: DraftRequest): DraftResult {
    const look = this.lookup();
    const empty: DraftResult = { candidates: [], threats: [], me: null, hasSynergy: false, patch: null, statsAt: null, error: this.error };
    if (!look) return empty;
    const stats = look.data.stats;
    if (!stats) return { ...empty, patch: look.data.patch, error: 'Нет статистики патча (stats.json): подбор героя недоступен.' };
    const view = (r: DraftReason): DraftReasonView => ({ hero: r.hero, name: look.heroName(r.hero), delta: r.delta, games: r.games });

    const allies = req.me && !req.allies.includes(req.me) ? [...req.allies, req.me] : req.allies;
    const candidates = req.me
      ? []
      : suggestHeroes(look, { allies, enemies: req.enemies, bans: req.bans, position: req.position, limit: 12 }).map((c) => ({
          ...c,
          vsEnemies: c.vsEnemies.map(view),
          withAllies: c.withAllies.map(view),
        }));

    const threats = enemyThreats(req.enemies, look.invisHeroes).map((t) => ({
      id: t.threat.id,
      nameRu: t.threat.nameRu,
      whyRu: t.threat.whyRu,
      heroes: t.heroes.map((h) => look.heroName(h)),
      urgent: t.threat.urgent,
      items: t.threat.items.map((i) => ({ key: i.key, name: look.itemName(i.key), cost: look.itemCost(i.key), role: i.role })),
    }));

    let me: DraftResult['me'] = null;
    if (req.me && look.heroByKey.has(req.me)) {
      const role = itemRole(look.statsFor(null, req.me)?.pro?.positions, look.heroByKey.get(req.me)?.roles ?? [], look.statsFor(null, req.me)?.pro?.games ?? 0);
      const vs = req.enemies.map((e) => counterDelta(look, req.me!, e)).filter((x): x is DraftReason => x !== null);
      const wi = req.allies.filter((a) => a !== req.me).map((a) => synergyDelta(look, req.me!, a)).filter((x): x is DraftReason => x !== null);
      me = {
        hero: req.me,
        name: look.heroName(req.me),
        role,
        worst: vs.filter((x) => x.delta < 0).sort((a, b) => a.delta - b.delta).map(view),
        best: [...vs.filter((x) => x.delta > 0), ...wi.filter((x) => x.delta > 0)].sort((a, b) => b.delta - a.delta).map(view),
      };
      // предметы под мою роль — первыми
      const mine = new Set(counterItems(enemyThreats(req.enemies, look.invisHeroes), role).map((c) => c.key));
      for (const t of threats) t.items.sort((a, b) => Number(mine.has(b.key)) - Number(mine.has(a.key)));
    }

    // Герой без записи в статистике молча выпал бы из расчёта, и подбор выглядел бы полным — называем его
    const noStats = [...new Set([...req.allies, ...req.enemies, ...(req.me ? [req.me] : [])])]
      .filter((k) => look.heroByKey.has(k) && look.winrate(k) === null)
      .map((k) => look.heroName(k));

    return {
      candidates,
      threats,
      me,
      noStats,
      hasSynergy: stats.heroes.some((h) => Object.keys(h.synergy).length > 0),
      patch: stats.patch,
      statsAt: stats.generatedAt,
      error: null,
    };
  }
}

/** Герои текущего матча из последнего снимка движка подсказок */
export function liveHeroes(v: CoachView | null, look: CoachLookup | null): DraftLiveHeroes {
  if (!v) return { inGame: false, me: null, allies: [], enemies: [] };
  const key = (p: { hero: { value: string | null } }) => p.hero.value;
  const mh = v.me.hero.value;
  const me = mh ? (mh.key ?? (mh.id !== null ? (look?.heroById.get(mh.id)?.key ?? null) : null)) : null;
  return {
    inGame: v.inGame,
    me,
    allies: v.allies.map(key).filter((k): k is string => !!k && k !== me),
    enemies: v.enemies.map(key).filter((k): k is string => !!k),
  };
}

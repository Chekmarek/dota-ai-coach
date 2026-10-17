// Набор ситуаций драфта для проверки ИИ (tests/ai/draft-questions.json): факты и ожидаемые выводы считают правила.
//   node --experimental-transform-types tests/ai/make-draft-questions.ts
// Набор детерминирован (статистика патча 7.41f); после смены stats.json его пересоздают и смотрят разницу.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { counterItems, draftFacts, enemyThreats, itemRole, suggestHeroes } from '../../src/core/draft/index.ts';
import { realData } from '../unit/coach-sim.ts';

const data = realData();
const look = new CoachLookup(data);

// Враги, союзники, позиция: от одного врага до полного драфта, все позиции, известные контрпики
const SETUPS: [string[], string[], number | null][] = [
  [['bristleback'], [], null],
  [['phantom_assassin'], [], null],
  [['riki'], [], 5],
  [['antimage'], [], 2],
  [['pudge'], [], 4],
  [['invoker'], ['lion'], 1],
  [['huskar'], [], 3],
  [['meepo'], [], null],
  [['bristleback', 'invoker'], ['lion'], null],
  [['phantom_lancer', 'crystal_maiden'], [], 3],
  [['slark', 'lion'], ['axe'], 2],
  [['templar_assassin', 'shadow_shaman'], ['juggernaut'], 5],
  [['tinker', 'sniper'], [], 4],
  [['necrolyte', 'drow_ranger'], ['earthshaker'], 1],
  [['ursa', 'witch_doctor', 'tidehunter'], [], null],
  [['storm_spirit', 'faceless_void', 'lion'], ['crystal_maiden'], 1],
  [['spectre', 'zuus', 'bane'], ['pudge', 'sven'], 2],
  [['alchemist', 'enigma', 'oracle'], ['invoker'], 3],
  [['weaver', 'viper', 'disruptor'], ['mars', 'lina'], 4],
  [['broodmother', 'leshrac', 'treant'], [], 5],
  [['terrorblade', 'puck', 'centaur', 'lich'], ['ursa'], null],
  [['chaos_knight', 'void_spirit', 'beastmaster', 'jakiro'], ['windrunner', 'shadow_shaman'], 1],
  [['luna', 'queenofpain', 'dark_seer', 'rubick'], ['legion_commander'], 2],
  [['troll_warlord', 'kunkka', 'legion_commander', 'dazzle', 'lion'], [], null],
  [['bristleback', 'invoker', 'riki', 'lion', 'faceless_void'], ['axe', 'crystal_maiden'], 1],
  [['phantom_lancer', 'ember_spirit', 'axe', 'witch_doctor', 'rubick'], ['sven', 'tinker', 'tusk'], 5],
  [['medusa', 'nyx_assassin', 'mars', 'shadow_shaman', 'skywrath_mage'], ['slark', 'pugna'], 3],
  [['life_stealer', 'kez', 'abaddon', 'oracle', 'tidehunter'], ['zuus', 'pudge', 'lich'], 2],
  [['juggernaut', 'storm_spirit', 'sand_king', 'vengefulspirit', 'treant'], ['monkey_king', 'enigma', 'ogre_magi', 'drow_ranger'], 4],
  [['sniper', 'templar_assassin', 'bounty_hunter', 'warlock', 'shadow_demon'], ['faceless_void', 'puck', 'magnataur'], null],
  [['naga_siren', 'clinkz', 'centaur', 'hoodwink', 'chen'], ['antimage'], 4],
  [['skeleton_king', 'batrider', 'doom_bringer', 'undying', 'grimstroke'], ['gyrocopter', 'death_prophet'], 2],
  [['morphling', 'arc_warden', 'primal_beast', 'snapfire', 'disruptor'], [], 5],
  [['marci', 'muerta', 'dawnbreaker', 'ringmaster', 'largo'], ['lina', 'axe'], 1],
];

const out = SETUPS.map(([enemies, allies, position], n) => {
  for (const k of [...enemies, ...allies]) if (!look.heroByKey.has(k)) throw new Error(`нет героя ${k}`);
  const cands = suggestHeroes(look, { allies, enemies, position, limit: 3 });
  const threats = enemyThreats(enemies, look.invisHeroes);
  const facts = draftFacts({ candidates: cands, name: (k) => look.heroName(k), enemies, allies, position, patch: data.stats?.patch ?? null, statsAt: data.stats?.generatedAt ?? null, compact: true });
  const top = cands[0]!;
  const role = itemRole(look.statsFor(null, top.hero)?.pro?.positions, look.heroByKey.get(top.hero)?.roles ?? [], look.statsFor(null, top.hero)?.pro?.games ?? 0);
  return {
    id: `d${String(n + 1).padStart(2, '0')}`,
    enemies,
    allies,
    position,
    facts,
    expect: {
      /** Лучший кандидат правил — его ИИ называет первым */
      topHero: top.hero,
      topName: top.name,
      /** Все герои, которых можно назвать (враги, союзники, кандидаты) */
      allowedHeroes: [...new Set([...enemies, ...allies, ...cands.map((c) => c.hero)])],
      /** Риски врагов и что купить лучшему кандидату (для уведомления «Угрозы»; ИИ их не придумывает) */
      threats: threats.map((t) => t.threat.id),
      itemsForTop: counterItems(threats, role).map((c) => c.key),
    },
  };
});

writeFileSync(join(import.meta.dirname, 'draft-questions.json'), JSON.stringify({ patch: data.stats?.patch, statsAt: data.stats?.generatedAt, cases: out }, null, 2));
console.log(`ситуаций: ${out.length}; лучшие: ${out.map((c) => c.expect.topName).join(', ')}`);

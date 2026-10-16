// Угрозы вражеских героев и предметы против них — для драфта и подсказок «что купить против врагов».
// Таблица составлена вручную по общеизвестным свойствам героев (не по статистике): герой → типы угроз.
// Невидимость дополнительно берётся из описаний способностей базы знаний (CoachLookup.invisHeroes).
// Предмет советуем только той роли, которой он подходит: саппорту — дешёвые командные, кору — свои.

export type ThreatId = 'invis' | 'illusions' | 'healing' | 'evasion' | 'magic' | 'disable' | 'physical' | 'summons' | 'passives' | 'mobile';

export type ItemRole = 'core' | 'support' | 'any';

export interface CounterItem {
  key: string;
  role: ItemRole;
}

export interface Threat {
  id: ThreatId;
  nameRu: string;
  /** Короткое «почему»: что делает угроза */
  whyRu: string;
  /** Предметы по порядку полезности */
  items: CounterItem[];
  /** Срочно (нужно с первых минут, как пыль против Рики) — иначе к средней игре */
  urgent: boolean;
}

export const THREATS: Record<ThreatId, Threat> = {
  invis: {
    id: 'invis',
    nameRu: 'невидимость',
    whyRu: 'без обнаружения его не ударить',
    items: [
      { key: 'dust', role: 'any' },
      { key: 'ward_sentry', role: 'support' },
      { key: 'gem', role: 'core' },
    ],
    urgent: true,
  },
  illusions: {
    id: 'illusions',
    nameRu: 'иллюзии и копии',
    whyRu: 'нужен урон по площади',
    items: [
      { key: 'bfury', role: 'core' },
      { key: 'mjollnir', role: 'core' },
      { key: 'radiance', role: 'core' },
      { key: 'shivas_guard', role: 'core' },
    ],
    urgent: false,
  },
  healing: {
    id: 'healing',
    nameRu: 'лечение и реген',
    whyRu: 'режьте лечение',
    items: [
      { key: 'spirit_vessel', role: 'support' },
      { key: 'shivas_guard', role: 'core' },
    ],
    urgent: false,
  },
  evasion: {
    id: 'evasion',
    nameRu: 'уклонение',
    whyRu: 'атаки промахиваются',
    items: [
      { key: 'monkey_king_bar', role: 'core' },
      { key: 'bloodthorn', role: 'core' },
    ],
    urgent: false,
  },
  magic: {
    id: 'magic',
    nameRu: 'магический урон',
    whyRu: 'убивает заклинаниями',
    items: [
      { key: 'black_king_bar', role: 'core' },
      { key: 'pipe', role: 'support' },
      { key: 'glimmer_cape', role: 'support' },
      { key: 'eternal_shroud', role: 'core' },
    ],
    urgent: false,
  },
  disable: {
    id: 'disable',
    nameRu: 'контроль',
    whyRu: 'долго держит в оглушении',
    items: [
      { key: 'black_king_bar', role: 'core' },
      { key: 'sphere', role: 'core' },
      { key: 'lotus_orb', role: 'support' },
      { key: 'cyclone', role: 'support' },
    ],
    urgent: false,
  },
  physical: {
    id: 'physical',
    nameRu: 'физический урон',
    whyRu: 'бьёт руками',
    items: [
      { key: 'ghost', role: 'support' },
      { key: 'solar_crest', role: 'support' },
      { key: 'heavens_halberd', role: 'core' },
      { key: 'assault', role: 'core' },
      { key: 'shivas_guard', role: 'core' },
    ],
    urgent: false,
  },
  summons: {
    id: 'summons',
    nameRu: 'призванные существа',
    whyRu: 'много юнитов',
    items: [
      { key: 'crimson_guard', role: 'core' },
      { key: 'mjollnir', role: 'core' },
      { key: 'shivas_guard', role: 'core' },
    ],
    urgent: false,
  },
  passives: {
    id: 'passives',
    nameRu: 'сильные пассивки',
    whyRu: 'сила в пассивных способностях',
    items: [
      { key: 'silver_edge', role: 'core' },
      { key: 'spirit_vessel', role: 'support' },
    ],
    urgent: false,
  },
  mobile: {
    id: 'mobile',
    nameRu: 'подвижность',
    whyRu: 'сразу уходит или прыгает',
    items: [
      { key: 'orchid', role: 'core' },
      { key: 'sheepstick', role: 'core' },
      { key: 'abyssal_blade', role: 'core' },
      { key: 'cyclone', role: 'support' },
    ],
    urgent: false,
  },
};

/** Герой → угрозы. Только уверенно известные свойства; сомнительное не пишем */
export const HERO_THREATS: Record<string, ThreatId[]> = {
  riki: ['invis', 'evasion'],
  bounty_hunter: ['invis'],
  clinkz: ['invis', 'physical'],
  weaver: ['invis', 'mobile', 'physical'],
  nyx_assassin: ['invis', 'magic'],
  templar_assassin: ['invis', 'physical'],
  invoker: ['invis', 'magic'],
  mirana: ['invis'],
  sand_king: ['invis', 'magic'],
  treant: ['invis', 'healing'],
  hoodwink: ['invis'],
  phantom_lancer: ['illusions', 'mobile'],
  naga_siren: ['illusions'],
  terrorblade: ['illusions', 'physical'],
  chaos_knight: ['illusions', 'physical'],
  meepo: ['illusions'],
  necrolyte: ['healing', 'magic'],
  alchemist: ['healing'],
  huskar: ['healing', 'passives'],
  omniknight: ['healing'],
  oracle: ['healing'],
  abaddon: ['healing'],
  witch_doctor: ['healing'],
  warlock: ['healing', 'summons'],
  dazzle: ['healing'],
  phantom_assassin: ['evasion', 'physical', 'passives'],
  windrunner: ['evasion'],
  lion: ['magic', 'disable'],
  lina: ['magic'],
  zuus: ['magic'],
  skywrath_mage: ['magic'],
  leshrac: ['magic'],
  tinker: ['magic', 'mobile'],
  queenofpain: ['magic', 'mobile'],
  pugna: ['magic'],
  storm_spirit: ['magic', 'mobile'],
  shadow_shaman: ['disable', 'summons'],
  bane: ['disable'],
  doom_bringer: ['disable'],
  legion_commander: ['disable', 'physical'],
  batrider: ['disable'],
  beastmaster: ['disable', 'summons'],
  enigma: ['disable', 'summons'],
  faceless_void: ['disable', 'physical'],
  troll_warlord: ['physical'],
  ursa: ['physical', 'passives'],
  slark: ['physical', 'mobile'],
  juggernaut: ['physical'],
  sven: ['physical'],
  life_stealer: ['physical', 'healing'],
  drow_ranger: ['physical'],
  sniper: ['physical'],
  luna: ['physical'],
  monkey_king: ['physical'],
  antimage: ['mobile', 'physical'],
  ember_spirit: ['mobile'],
  puck: ['mobile', 'magic'],
  void_spirit: ['mobile', 'magic'],
  broodmother: ['summons'],
  furion: ['summons'],
  lycan: ['summons', 'physical'],
  chen: ['summons', 'healing'],
  visage: ['summons'],
  bristleback: ['passives'],
  spectre: ['passives', 'illusions'],
  shredder: ['passives', 'magic'],
  tidehunter: ['passives'],
};

export interface ThreatReport {
  threat: Threat;
  /** Враги с этой угрозой */
  heroes: string[];
}

/** Угрозы вражеской команды: от самых частых; невидимость — ещё и по описанию способностей */
export function enemyThreats(enemies: readonly string[], invisHeroes: ReadonlySet<string> = new Set()): ThreatReport[] {
  const by = new Map<ThreatId, string[]>();
  for (const e of new Set(enemies)) {
    const ids = new Set(HERO_THREATS[e] ?? []);
    if (invisHeroes.has(e)) ids.add('invis');
    for (const id of ids) by.set(id, [...(by.get(id) ?? []), e]);
  }
  return [...by.entries()]
    .map(([id, heroes]) => ({ threat: THREATS[id], heroes }))
    .sort((a, b) => Number(b.threat.urgent) - Number(a.threat.urgent) || b.heroes.length - a.heroes.length);
}

/** Роль моего героя для выбора предметов: позиции 4–5 — саппорт; без позиций — по ролям базы знаний */
export function itemRole(positions: readonly number[] | null | undefined, kbRoles: readonly string[], proGames = Infinity): 'core' | 'support' {
  if (positions && positions.length === 5 && proGames >= 15) {
    const sup = (positions[3] ?? 0) + (positions[4] ?? 0);
    return sup > 0.5 ? 'support' : 'core';
  }
  return kbRoles.includes('Support') && !kbRoles.includes('Carry') ? 'support' : 'core';
}

export interface CounterSuggestion {
  key: string;
  threat: ThreatId;
  threatRu: string;
  whyRu: string;
  heroes: string[];
  urgent: boolean;
}

/** Предметы против вражеской команды для моей роли; уже купленные пропускаются, каждый предмет — один раз */
export function counterItems(threats: readonly ThreatReport[], role: 'core' | 'support', owned: ReadonlySet<string> = new Set()): CounterSuggestion[] {
  const out: CounterSuggestion[] = [];
  for (const t of threats) {
    for (const it of t.threat.items) {
      if (it.role !== 'any' && it.role !== role) continue;
      if (owned.has(it.key) || out.some((o) => o.key === it.key)) continue;
      out.push({ key: it.key, threat: t.threat.id, threatRu: t.threat.nameRu, whyRu: t.threat.whyRu, heroes: t.heroes, urgent: t.threat.urgent });
      break; // на угрозу — лучший подходящий предмет; остальные — в интерфейсе драфта
    }
  }
  return out;
}

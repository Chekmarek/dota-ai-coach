// Драфт: подбор героя по врагам и союзникам, угрозы вражеской команды и предметы против них.
export { suggestHeroes, worstMatchups, counterDelta, synergyDelta, heroPositions, pctRu, type DraftInput, type DraftCandidate, type DraftReason } from './suggest.ts';
export { enemyThreats, counterItems, itemRole, THREATS, HERO_THREATS, ENEMY_ITEM_ANSWERS, ANSWER_ANY_HERO, type Threat, type ThreatId, type ThreatReport, type CounterSuggestion } from './threats.ts';
export { draftFacts, draftNotice, gamesRu, type DraftFactsInput } from './facts.ts';

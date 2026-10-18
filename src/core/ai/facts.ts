// Сборка фактов для ИИ (этап 3): одна точка входа для всех экранов. Факты — короткие строки по-русски, которые
// посчитал коуч: текущий матч (модель матча / buildAiContext), база знаний (по названиям в вопросе и в матче),
// «Разбор записи» (та же модель матча, построенная по видео/кадрам) и история (факты после матча, этап 4).
// Неизвестное пишется явно («неизвестно»), у непроверенных значений — пометка «не проверено».
// Чистое ядро: без Electron, DOM, сети и файлов.
import type { KbAbility, KbHero, KbItem, KnowledgeBase } from '../../shared/types/kb.ts';
import type { MechanicsEntry } from '../../shared/types/mechanics.ts';
import type { MatchEvent, MatchState, Tracked, TrackedItemSlot } from '../match-state/types.ts';
import { MAP_ZONE_RU } from '../match-state/map-zones.ts';
import { buildAiContext, type Fact } from './context.ts';
import { HERO_ALIASES, ITEM_ALIASES } from './aliases.ts';
import { gameModeRu, type GameModeInfo } from '../gsi/mode.ts';
import { turboMechanics, type ModeOverrides } from '../knowledge-base/modes.ts';

export type AiPage = 'assistant' | 'live' | 'replay' | 'match' | 'kb' | 'summary';

export interface FactsInput {
  page: AiPage;
  question?: string;
  /** Модель матча: живая игра или «Разбор записи» (replay = true) */
  match?: MatchState | null;
  replay?: boolean;
  kb?: KnowledgeBase | null;
  /** Факты после матча из истории (этап 4) */
  history?: { label: string; lines: string[] } | null;
  /** Что ещё показывает страница (например, открытая запись базы знаний) */
  extra?: string[];
  /** Режим игры (с ручным выбором); есть — ИИ получает строку о режиме, в Турбо — механику Турбо */
  mode?: GameModeInfo | null;
  /** Справочник Турбо (src/data/modes/turbo.json) */
  turbo?: ModeOverrides | null;
}

export interface AiFacts {
  lines: string[];
  /** Какие данные использованы — для подписи под ответом */
  used: string[];
}

/** Сколько найденных по вопросу записей базы знаний брать */
const MAX_KB_HITS = 4;
const MAX_MECHANICS_HITS = 3;
const MAX_EVENTS = 12;

// ---------- форматирование ----------

/** Секунды → «м:сс» (до горна — «-0:30») */
export function mmss(sec: number): string {
  const s = Math.round(sec);
  const a = Math.abs(s);
  return `${s < 0 ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const UNIT_RU: Record<string, string> = {
  gold: 'золота',
  xp: 'опыта',
  hp: 'здоровья',
  armor: 'брони',
  mana: 'маны',
  'gold/min': 'золота в минуту',
  'hp/s': 'здоровья в секунду',
  '%': '%',
};

function valueText(v: number | string | null, unit: string | null | undefined): string {
  if (v === null) return 'нет данных';
  if (typeof v === 'string') return v;
  if (unit === 's') return v >= 60 ? `${v} с (${mmss(v)})` : `${v} с`;
  const u = unit ? UNIT_RU[unit] : undefined;
  if (u === '%') return `${v}%`;
  return u ? `${v} ${u}` : `${v}`;
}

// ---------- поиск названий в вопросе ----------

/** Нижний регистр, ё → е, всё кроме букв и цифр — пробелы */
export function normalize(s: string): string {
  return ` ${s.toLowerCase().replace(/ё/g, 'е').replace(/[’'`]/g, '').replace(/[^a-zа-я0-9]+/g, ' ').trim()} `;
}

/** Падежные окончания для коротких русских названий («акс» → «акса», «аксу», «аксом») */
const SHORT_ENDINGS = '(?:а|у|ом|е|ы|ой|ов|ам|ами|ах)?';

/**
 * Встречается ли название в нормализованном тексте. Несколько слов — подстрокой. Латиница: слово целиком
 * (у длинных — с хвостом до 2 букв: «blinks»). Кириллица: основа без конечной гласной + окончание
 * («манта» → «манты», «пудж» → «пуджа»); у основы короче 4 букв окончание только падежное («бкб», «акса»).
 */
export function mentions(text: string, alias: string): boolean {
  const a = normalize(alias).trim();
  if (!a) return false;
  if (a.includes(' ')) return text.includes(` ${a} `) || new RegExp(` ${a}[a-zа-я]{0,3} `).test(text);
  if (/^[a-z0-9]+$/.test(a)) return a.length <= 3 ? text.includes(` ${a} `) : new RegExp(` ${a}[a-z]{0,2} `).test(text);
  const stem = a.length >= 4 ? a.replace(/[аяоеыиьй]$/, '') : a;
  if (stem.length <= 3) return new RegExp(` ${stem}${SHORT_ENDINGS} `).test(text);
  return new RegExp(` ${stem}[а-я]{0,3} `).test(text);
}

function heroNames(h: KbHero): string[] {
  return [h.name, h.key.replace(/_/g, ' '), ...(HERO_ALIASES[h.key] ?? [])];
}

function itemNames(it: KbItem): string[] {
  return [it.name, it.key.replace(/_/g, ' '), ...(ITEM_ALIASES[it.key] ?? [])];
}

export function findHeroes(kb: KnowledgeBase, text: string): KbHero[] {
  const t = normalize(text);
  return kb.heroes.filter((h) => heroNames(h).some((n) => mentions(t, n)));
}

export function findItems(kb: KnowledgeBase, text: string): KbItem[] {
  const t = normalize(text);
  return kb.items.filter((it) => !it.key.startsWith('recipe_') && itemNames(it).some((n) => mentions(t, n)));
}

export function findAbilities(kb: KnowledgeBase, text: string): { hero: KbHero; ability: KbAbility }[] {
  const t = normalize(text);
  const out: { hero: KbHero; ability: KbAbility }[] = [];
  for (const h of kb.heroes) for (const a of h.abilities) if (a.name.length >= 4 && mentions(t, a.name)) out.push({ hero: h, ability: a });
  return out;
}

/** Сленг, которого нет в названиях механики */
const MECHANICS_SLANG: [RegExp, string[]][] = [
  [/ рош/, ['roshan-respawn', 'roshan-start', 'roshan-drops']],
  [/ аег| аэг| aegis/, ['roshan-drops']],
  [/ торм| мучит/, ['tormentor-spawn', 'tormentor-reward']],
  [/ байб| выкуп| buyback/, ['buyback-cost', 'buyback-cooldown']],
  [/ респ| возрожд| воскрес/, ['respawn-time']],
  [/ стак/, ['neutral-stack-window', 'neutral-stack-bounty']],
  [/ пул| отвод| оттяг/, ['neutral-pull-general', 'neutral-pull-per-lane']],
  [/ баунти| bounty| золот[а-я]* рун/, ['rune-bounty']],
  [/ пауэр| power| рун[а-я]* сил/, ['rune-power']],
  [/ вод[а-я]* рун| water/, ['rune-water']],
  [/ мудр| wisdom/, ['rune-wisdom', 'shrine-of-wisdom']],
  [/ лотос/, ['lotus-pool']],
  [/ ноч| день| дня| сутк/, ['day-night-cycle']],
  [/ нейтрал[а-я]* предм| нейтралк/, ['neutral-items-tiers', 'neutral-items-t1']],
  [/ лагер| кемп| нейтрал/, ['neutral-spawn']],
  [/ вард| obs| обсер/, ['ward-observer']],
  [/ сентр/, ['ward-sentry']],
  [/ смок/, ['smoke-of-deceit']],
  [/ скан/, ['scan']],
  [/ глиф/, ['glyph']],
  [/ курьер/, ['courier']],
  [/ вышк| башн| тавер/, ['towers']],
  [/ бараки| барак/, ['barracks']],
  [/ волн| крип/, ['lane-wave-spawn', 'lane-wave-composition']],
  [/ катапульт| осадн/, ['lane-siege-cadence']],
  [/ аутпост| outpost/, ['outpost']],
  [/ твин| врат/, ['twin-gate']],
];

const stem = (w: string) => w.slice(0, 5);
const STOP = new Set(['сколько', 'какой', 'какая', 'какие', 'когда', 'через', 'время', 'нужно', 'можно', 'будет', 'сейчас', 'почему', 'зачем', 'минут', 'секунд']);

export function findMechanics(mechanics: readonly MechanicsEntry[], text: string): MechanicsEntry[] {
  const t = normalize(text);
  const slang = new Set<string>();
  for (const [re, ids] of MECHANICS_SLANG) if (re.test(t)) for (const id of ids) slang.add(id);
  const q = new Set(
    t
      .split(' ')
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map(stem),
  );
  const scored = mechanics.map((m, i) => {
    const title = new Set(normalize(`${m.nameRu} ${m.values.map((v) => v.labelRu).join(' ')}`).split(' ').filter((w) => w.length >= 4).map(stem));
    let s = 0;
    for (const w of q) if (title.has(w)) s += 2;
    if (slang.has(m.id)) s += 5;
    return { m, i, s };
  });
  // одно случайное общее слово («основной» ↔ «Основа») — не повод: нужно два слова или сленг
  return scored
    .filter((x) => x.s >= 4)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, MAX_MECHANICS_HITS)
    .map((x) => x.m);
}

// ---------- факты базы знаний ----------

const ATTR_RU: Record<string, string> = { str: 'сила', agi: 'ловкость', int: 'интеллект', all: 'универсальный' };
const AVAIL_RU: Record<string, string> = { shop: 'продаётся в магазине', neutral: 'нейтральный предмет', 'not-sold': 'не продаётся', removed: 'нет в игре' };

export function heroFact(h: KbHero, patch: string): string {
  const s = h.stats;
  return (
    `Герой ${h.name} (база знаний ${patch}): основной атрибут — ${h.primaryAttr ? ATTR_RU[h.primaryAttr] : 'неизвестно'}, ` +
    `${h.attackType === 'ranged' ? 'дальний бой' : h.attackType === 'melee' ? 'ближний бой' : 'тип атаки неизвестен'}, ` +
    `на 1 уровне здоровье ${s.maxHealth}, мана ${s.maxMana}, броня ${round1(s.armor)}, урон ${s.damageMin}–${s.damageMax}, ` +
    `скорость передвижения ${s.moveSpeed}, дальность атаки ${s.attackRange}, ` +
    `сила ${s.str.base} (+${s.str.gain} за уровень), ловкость ${s.agi.base} (+${s.agi.gain}), интеллект ${s.int.base} (+${s.int.gain}), ` +
    `обзор днём ${s.sightDay}, ночью ${s.sightNight}`
  );
}

export function abilityFact(h: KbHero, a: KbAbility, withDesc: boolean): string {
  const cd = a.cooldowns.some((x) => x > 0) ? `перезарядка ${a.cooldowns.join('/')} с` : 'без перезарядки';
  const mana = a.manaCosts.some((x) => x > 0) ? `, мана ${a.manaCosts.join('/')}` : '';
  const desc = withDesc && a.descRu ? `. ${a.descRu.split(/(?<=\.)\s/)[0]}` : '';
  return `Способность ${a.name} (${h.name}): ${cd}${mana}${a.scepter ? ', улучшается Аганимом' : ''}${desc}`;
}

export function itemFact(it: KbItem, kb: KnowledgeBase): string {
  const parts: string[] = [];
  if (it.cost !== null) parts.push(`цена ${it.cost} золота${it.priceSource === 'opendota' ? ' (по OpenDota, не проверено)' : ''}`);
  else parts.push('цены нет в базе');
  if (it.components.length) {
    const names = it.components.map((k) => kb.items.find((x) => x.key === k)?.name ?? k);
    parts.push(`собирается из: ${names.join(', ')}${it.recipeCost ? ` + рецепт ${it.recipeCost} золота` : ''}`);
  }
  if (it.cooldown) parts.push(`перезарядка ${it.cooldown} с`);
  if (it.manaCost) parts.push(`мана ${it.manaCost}`);
  const avail = it.availability ?? 'shop';
  parts.push(avail === 'neutral' && it.neutralTier ? `нейтральный предмет ${it.neutralTier} уровня` : AVAIL_RU[avail]!);
  return `Предмет ${it.name}: ${parts.join(', ')}`;
}

export function mechanicsFact(m: MechanicsEntry): string {
  const vals = m.values.map((v) => `${v.labelRu} — ${valueText(v.value, v.unit)}`).join('; ');
  const flag = m.verification === 'verified' ? '' : m.verification === 'missing' ? ', значения нет в источниках' : ', не проверено';
  const notes = m.notesRu ? ` ${m.notesRu.slice(0, 140)}` : '';
  return `${m.nameRu}: ${vals}.${notes} (${m.source.name}${flag})`;
}

// ---------- факты матча ----------

function known<T>(t: Tracked<T>): t is Tracked<T> & { value: T } {
  return t.value !== null && t.tag !== 'unknown';
}

function seen<T>(f: Fact<T>): string {
  if ('reason' in f) return '';
  return f.tag === 'remembered' && f.ageSec >= 5 ? ` (видели ${Math.round(f.ageSec)} с назад)` : f.tag === 'inferred' ? ' (вывод)' : '';
}

const UNKNOWN_RU: Record<string, string> = {
  'never-observed': 'ещё не видели',
  expired: 'давно не видели',
  'hero-not-identified': 'герой ещё не определён',
  'not-linked': 'не видно',
  'team-unknown': 'своя команда неизвестна',
  'clock-unknown': 'игровое время неизвестно',
  'no-knowledge-base': 'нет базы знаний',
  'not-applicable': 'не относится',
  'not-in-knowledge-base': 'нет в базе знаний',
};

function factLine<T>(label: string, f: Fact<T>, fmt: (v: T) => string): string {
  if ('reason' in f) return `${label}: неизвестно (${UNKNOWN_RU[f.reason] ?? f.reason})`;
  return `${label}: ${fmt(f.value)}${seen(f)}`;
}

function eventRu(e: MatchEvent): string | null {
  const d = e.data as Record<string, string | number | undefined>;
  switch (e.type) {
    case 'level-up':
      return `уровень ${d.to}`;
    case 'kill':
      return `убийство (всего ${d.to})`;
    case 'death':
      return `смерть (всего ${d.to})`;
    case 'assist':
      return `помощь в убийстве (всего ${d.to})`;
    case 'item-gained':
      return `появился предмет ${d.name ?? d.key}`;
    case 'item-lost':
      return `пропал предмет ${d.name ?? d.key}`;
    case 'day-night':
      return d.to === 'night' ? 'наступила ночь' : 'наступил день';
    case 'pause':
      return 'пауза';
    case 'unpause':
      return 'игра продолжилась';
    default:
      return null;
  }
}

function slotName(it: TrackedItemSlot): string | null {
  return known(it) && it.value.item ? it.value.item.name : null;
}

/** Значение или «неизвестно» — для строк, где несколько показателей подряд */
function part<T>(label: string, f: Fact<T>, fmt: (v: T) => string): string {
  return 'reason' in f ? `${label} неизвестно` : `${label} ${fmt(f.value)}`;
}

/** Название способности из базы знаний: shadowraze2 → Shadowraze (в базе одна запись на все три) */
function abilityName(key: string | null, index: number, hero: KbHero | undefined): string {
  if (!key) return `способность ${index + 1}`;
  const base = key.replace(/\d+$/, '');
  const a = hero?.abilities.find((x) => x.key === key) ?? hero?.abilities.find((x) => x.key.replace(/\d+$/, '') === base);
  return a?.name ?? key;
}

/** Факты текущего матча (или матча из записи): несколько показателей — в одной строке, чтобы подсказка была короче */
export function matchFacts(s: MatchState, kb: KnowledgeBase | null, replay: boolean): string[] {
  const ctx = buildAiContext(s, kb?.mechanics ?? null);
  const out: string[] = [];
  const src = replay ? 'запись' : 'матч';
  out.push(`Источник: ${replay ? 'разбор записи (видео или кадры)' : 'текущий матч'}; данные игры (GSI) ${ctx.sources.gsi ? 'есть' : 'нет'}, экран ${ctx.sources.screen ? 'есть' : 'нет'}`);
  const m = ctx.match;
  const head = [factLine('Игровое время', m.clockSec, (v) => `${mmss(v)}${m.paused ? ' (пауза)' : ''}`)];
  if (m.dayNight.value !== null) head.push(m.dayNight.value === 'day' ? 'день' : 'ночь');
  if (m.scoreRadiant.value !== null && m.scoreDire.value !== null) head.push(`счёт убийств: Силы Света ${m.scoreRadiant.value}, Силы Тьмы ${m.scoreDire.value}`);
  out.push(head.join('; '));

  const h = ctx.myHero;
  if ('reason' in h.hero) out.push(`Мой герой: неизвестно (${UNKNOWN_RU[h.hero.reason]})`);
  else {
    const bits = [
      part('уровень', h.level, (v) => `${v}`),
      part('золото', h.gold, (v) => `${v}`),
      part('здоровье', h.health, (v) => `${v.current} из ${v.max}`),
      part('мана', h.mana, (v) => `${v.current} из ${v.max}`),
      part('убийства/смерти/помощь', h.kda, (v) => `${v.kills}/${v.deaths}/${v.assists}`),
    ];
    if (known(s.hero.farm)) bits.push(`добито крипов ${s.hero.farm.value.lastHits}, не отдано ${s.hero.farm.value.denies}`);
    out.push(`Мой герой ${h.hero.value.name}${seen(h.hero)}: ${bits.join(', ')}`);
  }

  const inv = s.hero.items.filter((i) => i.slot.startsWith('inv')).map(slotName).filter((x): x is string => !!x);
  const bp = s.hero.items.filter((i) => i.slot.startsWith('bp')).map(slotName).filter((x): x is string => !!x);
  const extra = s.hero.extraItems ?? [];
  const stash = extra.filter((i) => i.slot.startsWith('stash')).map(slotName).filter((x): x is string => !!x);
  const tp = extra.find((i) => i.slot === 'tp');
  const neutral = extra.find((i) => i.slot === 'neutral');
  if (s.hero.items.some((i) => known(i))) {
    const bits = [inv.length ? inv.join(', ') : 'пусто'];
    if (bp.length) bits.push(`в рюкзаке: ${bp.join(', ')}`);
    if (stash.length) bits.push(`в тайнике: ${stash.join(', ')}`);
    if (tp && known(tp)) bits.push(`свиток телепорта ${tp.value.item ? 'есть' : 'нет'}`);
    if (neutral && known(neutral) && neutral.value.item) bits.push(`нейтральный: ${neutral.value.item.name}`);
    out.push(`Мои предметы: ${bits.join('; ')}`);
  } else out.push('Мои предметы: неизвестно (ещё не видели)');

  const heroKb = h.hero.value ? kb?.heroes.find((x) => x.id === h.hero.value!.id) : undefined;
  const abil: string[] = [];
  for (const a of s.hero.abilities) {
    if (!known(a.state)) continue;
    const st = a.state.value;
    const cd = st === 'cooldown' && known(a.cooldown) && a.cooldown.value > 0 ? ` ${Math.round(a.cooldown.value)} с` : '';
    const ru = st === 'ready' ? 'готова' : st === 'cooldown' ? `перезарядка${cd}` : st === 'no-mana' ? 'не хватает маны' : 'не изучена';
    const lvl = known(a.level) && a.level.value > 0 ? `, ур. ${a.level.value}` : '';
    abil.push(`${abilityName(a.key, a.index, heroKb)} — ${ru}${lvl}`);
  }
  if (abil.length) out.push(`Мои способности: ${abil.join('; ')}`);

  if (ctx.myTeam.value) out.push(`Моя команда: ${ctx.myTeam.value === 'radiant' ? 'Силы Света' : 'Силы Тьмы'}`);
  const groups = new Map<string, string[]>();
  for (const p of ctx.players) {
    if (p.hero.value === null) continue;
    const name = kb?.heroes.find((x) => x.key === p.hero.value)?.name ?? p.hero.value;
    const who = p.side === 'ally' ? 'Союзники' : p.side === 'enemy' ? 'Враги' : p.team === 'radiant' ? 'Силы Света' : 'Силы Тьмы';
    const bits: string[] = [];
    if (p.alive.value === false) bits.push(p.respawnAtSec.value !== null ? `мёртв, возродится в ${mmss(p.respawnAtSec.value)}` : 'мёртв');
    else if (p.alive.value === true) bits.push('жив');
    if (p.missing && p.missingForSec !== null) bits.push(`пропал с карты ${p.missingForSec} с назад`);
    if (p.position.value) bits.push(`${p.position.tag === 'visible' ? 'сейчас' : 'последний раз'}: ${MAP_ZONE_RU[p.position.value.zone]}`);
    if (p.hpPercent.value !== null) bits.push(`здоровье ${Math.round(p.hpPercent.value)}%`);
    const list = groups.get(who) ?? [];
    list.push(`${name}${bits.length ? ` (${bits.join(', ')})` : ''}`);
    groups.set(who, list);
  }
  for (const [who, list] of groups) out.push(`${who}: ${list.join('; ')}`);

  if ('reason' in ctx.timers) out.push(`Ближайшие события карты: неизвестно (${UNKNOWN_RU[ctx.timers.reason]})`);
  else {
    const t = ctx.timers.upcoming
      .slice()
      .sort((a, b) => (a.atSec ?? 1e9) - (b.atSec ?? 1e9))
      .map((e) => (e.atSec === null ? `${e.nameRu} — времени нет в базе` : `${e.nameRu} — в ${mmss(e.atSec)}${e.inSec !== null ? ` (через ${Math.round(e.inSec)} с)` : ''}`));
    if (t.length) out.push(`Ближайшие события карты (база знаний, не проверено): ${t.join('; ')}`);
  }

  const events = s.events.filter((e) => eventRu(e) !== null).slice(-MAX_EVENTS);
  if (events.length) out.push(`Последние события (${src}): ${events.map((e) => `${e.clock !== null ? mmss(e.clock) : '?'} — ${eventRu(e)}`).join('; ')}`);
  return out;
}

// ---------- сборка ----------

/** Есть ли в вопросе слова про способности (тогда добавляем способности найденных героев) */
const ABILITY_WORDS = / способн| скил| ульт| перезаряд| кулдаун| кд | cd | маны | мана /;
/** Вопрос про предметы — тогда справка по своим предметам из базы знаний */
const ITEM_WORDS = / предмет| айтем| шмот| слот| собра| собир| купи| покуп| цен| стои| золот| денег| деньг/;
/** Вопрос про характеристики своего героя */
const STAT_WORDS = / характерист| брон| скорост| атак| урон| дальн| обзор| атрибут| ловк| интел/;

export function assembleFacts(input: FactsInput): AiFacts {
  const lines: string[] = [];
  const used: string[] = [];
  const turboOn = input.mode?.mode === 'turbo';
  // В Турбо механика карты (тайминги, награды) — по справочнику Турбо, непроверенное — «нет данных»
  const kb = input.kb && turboOn ? { ...input.kb, mechanics: turboMechanics(input.kb.mechanics, input.turbo ?? null, input.kb.meta.patch) } : (input.kb ?? null);
  const q = input.question ?? '';
  const qn = normalize(q);
  const push = (l: string) => {
    if (!lines.includes(l)) lines.push(l);
  };

  // 0. Режим игры — первым: ИИ называет только его
  if (input.mode) {
    const m = input.mode;
    const tail = m.mode === 'turbo' ? ' — тайминги и награды Турбо (справочник Турбо)' : m.mode === 'unknown' ? ' — тайминги как в обычной игре' : '';
    push(`Режим игры: ${gameModeRu(m)}${tail}`);
  }

  // 1. База знаний — по названиям в вопросе
  if (kb && q) {
    const heroes = findHeroes(kb, q).slice(0, MAX_KB_HITS);
    const items = findItems(kb, q).slice(0, MAX_KB_HITS);
    const abilities = findAbilities(kb, q).slice(0, MAX_KB_HITS);
    const mech = findMechanics(kb.mechanics, q);
    for (const h of heroes) {
      push(heroFact(h, kb.meta.patch));
      if (ABILITY_WORDS.test(qn)) for (const a of h.abilities) push(abilityFact(h, a, false));
      else push(`Способности ${h.name}: ${h.abilities.map((a) => a.name).join(', ')}`);
    }
    for (const { hero, ability } of abilities) push(abilityFact(hero, ability, true));
    for (const it of items) push(itemFact(it, kb));
    for (const m of mech) push(mechanicsFact(m));
    const names = [...heroes.map((h) => h.name), ...abilities.map((a) => a.ability.name), ...items.map((i) => i.name), ...mech.map((m) => m.nameRu)];
    if (names.length) used.push(`База знаний ${kb.meta.patch}: ${names.join(', ')}`);
  }

  // 2. Страница: что она показывает
  for (const l of input.extra ?? []) push(l);

  // 3. Матч (живой или из записи)
  if (input.match) {
    for (const l of matchFacts(input.match, kb, !!input.replay)) push(l);
    used.push(input.replay ? 'Разбор записи: модель матча по кадрам' : `Текущий матч (${[input.match.sources.gsi && 'данные игры', input.match.sources.screen && 'экран'].filter(Boolean).join(' и ') || 'старые данные'})`);
    // База знаний о героях и предметах матча — кратко
    if (kb) {
      const id = input.match.hero.identity.value?.id;
      const my = id !== undefined ? kb.heroes.find((h) => h.id === id) : undefined;
      if (my && STAT_WORDS.test(qn)) push(heroFact(my, kb.meta.patch));
      if (my && ABILITY_WORDS.test(qn)) for (const a of my.abilities) push(abilityFact(my, a, false));
      const myItems = input.match.hero.items.map((i) => (known(i) ? i.value.item?.key : null)).filter((k): k is string => !!k);
      if (ITEM_WORDS.test(qn)) for (const k of new Set(myItems)) {
        const it = kb.items.find((x) => x.key === k);
        if (it) push(itemFact(it, kb));
      }
    }
  }

  // 4. История (после матча)
  if (input.history) {
    for (const l of input.history.lines) push(l);
    used.push(`История: ${input.history.label}`);
  }

  if (!lines.length) used.push('нет данных: ни матча, ни подходящих записей базы знаний');
  return { lines, used };
}

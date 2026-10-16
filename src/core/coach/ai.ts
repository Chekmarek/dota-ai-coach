// Слой ИИ движка подсказок: асинхронный, никогда не блокирует правила. Одна очередь запросов к модели
// (локальная модель отвечает на один запрос за раз): разбор смерти и матча > ошибка > совет «куда идти» > перефраз.
// Модель не считает и не придумывает: получает факты коуча и варианты, посчитанные правилами, и выбирает/пересказывает.
// Каждый ответ проверяется (числа и имена — только из фактов, выбор — только из вариантов); иначе — шаблон.
// Чистое ядро: поставщик передаётся снаружи.
import type { AiProvider } from '../ai/provider.ts';
import { COMMON, buildCardPrompt, buildSummaryPrompt, limitFacts } from '../ai/prompt.ts';
import { cleanAnswer } from '../ai/stream.ts';
import { checkGrounding } from '../ai/grounding.ts';
import { MAP_ZONE_RU, type MapZone } from '../match-state/map-zones.ts';
import { ACTION_RU, type Action, type ActionChoice } from './prob.ts';
import { poolPct, type CoachView } from './view.ts';
import { mmss } from './rules/context.ts';
import type { Hint } from './types.ts';
import { wordCount } from './types.ts';
import type { Mistake } from './mistakes.ts';
import type { DeathReview, MatchReview } from './reviews.ts';

export type AiJobKind = 'death' | 'match' | 'mistake' | 'advice' | 'phrase';
const JOB_PRIORITY: Record<AiJobKind, number> = { death: 5, match: 5, mistake: 3, advice: 2, phrase: 1 };
/** Время на ответ целиком (локальная модель на CPU: первый токен 1,3–2,5 с, ~28 токенов/с) */
export const AI_TIMEOUT_MS: Record<AiJobKind, number> = { death: 25_000, match: 60_000, mistake: 12_000, advice: 12_000, phrase: 10_000 };
const MAX_TOKENS: Record<AiJobKind, number> = { death: 160, match: 320, mistake: 60, advice: 60, phrase: 40 };
/** Пауза после ошибки поставщика, чтобы не долбить недоступную модель */
export const AI_BACKOFF_MS = 30_000;
/** Бюджет: не больше стольких советов и пересказов в минуту (разборы смерти и матча — вне бюджета) */
export const AI_LIVE_PER_MINUTE = 4;
const BUDGETED: ReadonlySet<AiJobKind> = new Set(['advice', 'phrase']);

export type AiResultReason = 'ok' | 'timeout' | 'error' | 'ungrounded' | 'empty' | 'invalid' | 'stale' | 'no-provider' | 'budget';

export interface AiJob<T> {
  kind: AiJobKind;
  /** Задание с тем же ключом заменяет старое в очереди */
  key: string;
  system: string;
  user: string;
  facts: string[];
  /** Проверка и разбор ответа; null — ответ не годится */
  validate: (text: string) => T | null;
  onResult: (r: { value: T | null; text: string; reason: AiResultReason; latencyMs: number }) => void;
  createdMs: number;
  /** После скольких мс ожидания задание теряет смысл */
  staleMs: number;
}

export interface CoachAiStats {
  ok: number;
  failed: number;
  timeouts: number;
  rejected: number;
  lastLatencyMs: number | null;
  busy: boolean;
  available: boolean;
  /** Всего обращений к модели */
  calls: number;
}

export class CoachAi {
  private queue: AiJob<unknown>[] = [];
  private running: { job: AiJob<unknown>; ctrl: AbortController } | null = null;
  private backoffUntil = 0;
  private liveCalls: number[] = [];
  readonly stats: CoachAiStats = { ok: 0, failed: 0, timeouts: 0, rejected: 0, lastLatencyMs: null, busy: false, available: true, calls: 0 };

  constructor(private readonly deps: { provider: () => AiProvider | null; now: () => number; timeoutMs?: Partial<Record<AiJobKind, number>>; livePerMinute?: number }) {}

  /** Бюджет советов и пересказов на эту минуту ещё есть */
  get budgetLeft(): boolean {
    const now = this.deps.now();
    this.liveCalls = this.liveCalls.filter((t) => now - t < 60_000);
    return this.liveCalls.length < (this.deps.livePerMinute ?? AI_LIVE_PER_MINUTE);
  }

  get busy(): boolean {
    return this.running !== null;
  }
  /** Есть поставщик и он не в паузе после ошибки */
  get available(): boolean {
    return this.deps.provider() !== null && this.deps.now() >= this.backoffUntil && this.budgetLeft;
  }
  pending(kind?: AiJobKind): number {
    return this.queue.filter((j) => !kind || j.kind === kind).length + (this.running && (!kind || this.running.job.kind === kind) ? 1 : 0);
  }

  enqueue<T>(job: AiJob<T>): void {
    this.queue = this.queue.filter((j) => j.key !== job.key);
    this.queue.push(job as AiJob<unknown>);
    this.queue.sort((a, b) => JOB_PRIORITY[b.kind] - JOB_PRIORITY[a.kind] || a.createdMs - b.createdMs);
    if (this.queue.length > 12) this.queue.length = 12;
    void this.pump();
  }

  cancelAll(): void {
    this.queue = [];
    this.running?.ctrl.abort();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const now = this.deps.now();
    // Устаревшие — сразу шаблоном
    for (const j of this.queue.filter((x) => now - x.createdMs > x.staleMs)) j.onResult({ value: null, text: '', reason: 'stale', latencyMs: 0 });
    this.queue = this.queue.filter((x) => now - x.createdMs <= x.staleMs);
    const job = this.queue.shift();
    if (!job) return;
    const provider = now >= this.backoffUntil ? this.deps.provider() : null;
    this.stats.available = provider !== null;
    if (!provider) {
      job.onResult({ value: null, text: '', reason: 'no-provider', latencyMs: 0 });
      return void this.pump();
    }
    if (BUDGETED.has(job.kind)) {
      if (!this.budgetLeft) {
        job.onResult({ value: null, text: '', reason: 'budget', latencyMs: 0 });
        return void this.pump();
      }
      this.liveCalls.push(now);
    }
    this.stats.calls++;
    const ctrl = new AbortController();
    this.running = { job, ctrl };
    this.stats.busy = true;
    const t0 = this.deps.now();
    const timeoutMs = this.deps.timeoutMs?.[job.kind] ?? AI_TIMEOUT_MS[job.kind];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    let text = '';
    let reason: AiResultReason = 'ok';
    let value: unknown = null;
    try {
      for await (const chunk of provider.generate({ system: job.system, messages: [{ role: 'user', content: job.user }], maxTokens: MAX_TOKENS[job.kind], temperature: 0.2, signal: ctrl.signal })) text += chunk;
      text = cleanAnswer(text);
      if (!text) reason = 'empty';
      else {
        value = job.validate(text);
        if (value === null) reason = 'invalid';
      }
    } catch {
      reason = timedOut ? 'timeout' : 'error';
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = this.deps.now() - t0;
    if (reason === 'ok') {
      this.stats.ok++;
      this.stats.lastLatencyMs = latencyMs;
    } else if (reason === 'timeout') this.stats.timeouts++;
    else if (reason === 'error') {
      this.stats.failed++;
      this.backoffUntil = this.deps.now() + AI_BACKOFF_MS;
    } else this.stats.rejected++;
    this.running = null;
    this.stats.busy = false;
    job.onResult({ value: reason === 'ok' ? value : null, text, reason, latencyMs });
    void this.pump();
  }
}

/** Ответ годится: числа и латинские имена есть в фактах */
export function grounded(text: string, facts: readonly string[]): boolean {
  return checkGrounding(text, facts).ok;
}

// ---------- Совет «что делать и куда идти» (постоянно, пока герой жив) ----------

export type Destination = MapZone | 'roshan';
export const DESTINATION_RU = (d: Destination): string => (d === 'roshan' ? 'яма Рошана' : MAP_ZONE_RU[d]);

export interface AdviceOption {
  actions: Action[];
  destinations: Destination[];
}

export interface Advice {
  action: Action;
  where: Destination;
  say: string;
}

/** Куда разумно идти для каждого действия (решают правила; ИИ только выбирает) */
export function adviceOptions(v: CoachView, choice: ActionChoice): AdviceOption {
  const team = v.team;
  const ownJungle: MapZone = team === 'dire' ? 'dire-jungle' : 'radiant-jungle';
  const ownBase: MapZone = team === 'dire' ? 'dire-base' : 'radiant-base';
  const actions = (Object.keys(choice.percents) as Action[]).filter((a) => choice.percents[a] >= 15 || a === choice.best);
  const dest = new Set<Destination>();
  for (const a of actions) {
    if (a === 'retreat') dest.add(ownBase).add(ownJungle);
    if (a === 'farm') {
      dest.add(ownJungle);
      if (v.me.zone && v.me.zone.endsWith('lane')) dest.add(v.me.zone);
    }
    if (a === 'push') ['top-lane', 'mid-lane', 'bot-lane'].forEach((z) => dest.add(z as MapZone));
    if (a === 'fight') {
      for (const al of v.allies) if (al.pos.value && (al.pos.ageSec ?? 99) <= 3 && v.me.zone) dest.add(v.me.zone);
      if ((v.clock.value ?? 0) >= 15 * 60) dest.add('roshan');
    }
  }
  if (!dest.size) dest.add(ownJungle);
  return { actions, destinations: [...dest] };
}

/** Факты для совета: только то, что знает коуч, коротко */
export function adviceFacts(v: CoachView, choice: ActionChoice, opts: AdviceOption): string[] {
  const hp = poolPct(v.me.hp.value);
  const mana = poolPct(v.me.mana.value);
  const missing = v.enemies.filter((e) => e.missing === true).length;
  const dead = v.enemies.filter((e) => e.alive.value === false).length;
  const alliesDead = v.allies.filter((e) => e.alive.value === false).length;
  return limitFacts([
    v.clock.value !== null ? `Игровое время: ${mmss(v.clock.value)}` : '',
    v.me.hero.value ? `Герой игрока: ${v.me.hero.value.name}` : '',
    v.me.level.value !== null ? `Уровень: ${v.me.level.value}` : '',
    hp !== null ? `Здоровье: ${Math.round(hp)}%` : '',
    mana !== null && (v.me.mana.value?.max ?? 0) > 0 ? `Мана: ${Math.round(mana)}%` : '',
    v.me.gold.value !== null ? `Золото: ${v.me.gold.value}` : '',
    v.me.zone ? `Где игрок: ${MAP_ZONE_RU[v.me.zone]}` : '',
    v.dayNight.value ? `Время суток: ${v.dayNight.value === 'day' ? 'день' : 'ночь'}` : '',
    v.enemies.length ? `Врагов не видно на мини-карте: ${missing}` : '',
    v.enemies.length ? `Врагов мертво: ${dead}` : '',
    v.allies.length ? `Союзников мертво: ${alliesDead}` : '',
    `Оценка коуча: ${opts.actions.map((a) => `${a} (${ACTION_RU[a].toLowerCase()}) ${choice.percents[a]}%`).join(', ')}`,
    ...choice.reasons.map((r) => `Причина: ${r}`),
    `Куда можно: ${opts.destinations.map((d) => `${d} (${DESTINATION_RU(d)})`).join(', ')}`,
  ].filter(Boolean));
}

export function buildAdvicePrompt(facts: string[], opts: AdviceOption): { system: string; user: string } {
  const system = [
    ...COMMON,
    'Ты подсказываешь игроку во время матча, что делать прямо сейчас и куда идти.',
    `Выбери ОДНО действие из: ${opts.actions.join(', ')} и ОДНО место из: ${opts.destinations.join(', ')}.`,
    'Ответь строго одной строкой JSON без пояснений: {"action":"…","where":"…","say":"…"}.',
    '"say" — совет игроку по-русски, не длиннее 12 слов, повелительное наклонение, без чисел, которых нет в фактах.',
    '',
    `Факты:\n${facts.map((f) => `- ${f}`).join('\n')}`,
  ].join('\n');
  return { system, user: 'Что мне делать и куда идти?' };
}

export function parseAdvice(text: string, opts: AdviceOption, facts: readonly string[]): Advice | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r['action'];
  const where = r['where'];
  const say = typeof r['say'] === 'string' ? r['say'].trim() : '';
  if (typeof action !== 'string' || !opts.actions.includes(action as Action)) return null;
  if (typeof where !== 'string' || !opts.destinations.includes(where as Destination)) return null;
  if (!say || say.length > 120 || wordCount(say) > 14) return null;
  if (!grounded(say, facts)) return null;
  return { action: action as Action, where: where as Destination, say };
}

// ---------- Пересказы: подсказка, ошибка, разборы ----------

export function phrasePrompt(h: Hint): { system: string; user: string; facts: string[] } {
  const facts = [`Подсказка: ${h.detail.normal}`, ...h.facts.filter((f) => f.value !== null).map((f) => `${f.label}: ${f.value}`)];
  const p = buildCardPrompt(h.ruleId, facts, h.priority);
  return { system: p.system, user: p.messages[0]!.content, facts: p.facts };
}

export function mistakePrompt(m: Mistake): { system: string; user: string; facts: string[] } {
  const facts = limitFacts([`Ошибка: ${m.text}`, `Как надо: ${m.instead}`, ...(m.clock !== null ? [`Время: ${mmss(m.clock)}`] : []), ...m.facts.filter((f) => f.value !== null).map((f) => `${f.label}: ${f.value}`)]);
  const system = [...COMMON, 'Объясни игроку его ошибку одной фразой до 20 слов: что не так и что делать вместо.', '', `Факты:\n${facts.map((f) => `- ${f}`).join('\n')}`].join('\n');
  return { system, user: 'Объясни ошибку.', facts };
}

export function deathPrompt(r: DeathReview): { system: string; user: string; facts: string[] } {
  const facts = limitFacts(r.facts);
  const system = [
    ...COMMON,
    'Игрок только что умер. Напиши разбор: 2–3 короткие строки, каждая начинается с «— ».',
    'Первая — почему умер, дальше — что сделать иначе. Тон спокойный, без оценок игрока.',
    '',
    `Факты:\n${facts.map((f) => `- ${f}`).join('\n')}`,
  ].join('\n');
  return { system, user: 'Почему я умер?', facts };
}

export function matchPrompt(r: MatchReview): { system: string; user: string; facts: string[] } {
  const p = buildSummaryPrompt(r.facts);
  return { system: p.system, user: p.messages[0]!.content, facts: p.facts };
}

/** Текст пересказа: годится, если не пустой и проверен по фактам */
export const validateText = (facts: readonly string[], maxWords: number) => (text: string): string | null => {
  const t = text.trim();
  if (!t || wordCount(t) > maxWords) return null;
  return grounded(t, facts) ? t : null;
};

// Когда звучит сигнал (чистая логика, время — снаружи). Правила «не раздражать»:
// - один момент — один звук: из всего, что случилось сразу, звучит важнейший сигнал;
// - тот же сигнал — не чаще своего кулдауна, любой сигнал — не чаще раза в 1,5 с;
// - срочные (опасность, «Отходи», «Вступай») — первыми и в драке; остальные в драке молчат (не копятся до конца драки);
// - сигнал, не прозвучавший за 2 с, выбрасывается — запоздалый звук хуже тишины;
// - советов и фоновых — не больше 2 в минуту (повторяющиеся напоминания не превращаются в перезвон);
// - «ульта готова» — только по переходу «перезарядка → готова» после первого снимка: при подключении к идущему
//   матчу и в начале игры пачки «готово» не бывает.
import { SOUND_CUES, SOUND_CUE_IDS, cueForHint, cueInFight, cuePriority, type SoundCueId } from './cues.ts';

/** Любой сигнал — не чаще (мс) */
export const SOUND_MIN_GAP_MS = 1500;
/** Сигнал старше (мс) не звучит */
export const SOUND_MAX_AGE_MS = 2000;
/** Не срочных сигналов (советы и фоновые) — не больше стольких за минуту; срочные — без ограничения (свой кулдаун) */
export const SOUND_CALM_PER_MIN = 2;

/** Состояние ульты для сигнала: изучена ли, на перезарядке ли, готова ли (null — не известно или пассивная) */
export type UltState = 'unlearned' | 'cooldown' | 'ready' | 'other' | null;

export interface SoundTick {
  nowMs: number;
  /** Подсказки, впервые показанные на этом тике (только видимые пользователю категории) */
  shown: readonly { id?: string; ruleId: string; category: string; priority: string; icon?: string | null }[];
  ult: UltState;
  /** Идёт драка рядом (враги вплотную) */
  inFight: boolean;
  /** Матч идёт; вне матча ульта не отслеживается и после начала нового — заново (разбор матча звучит и после конца) */
  inGame: boolean;
  /** Какие сигналы включены в настройках */
  enabled: ReadonlySet<SoundCueId>;
}

export class SoundDirector {
  private pending: { cue: SoundCueId; atMs: number }[] = [];
  private lastPlayed = new Map<SoundCueId, number>();
  private lastAnyMs = -Infinity;
  /** Когда звучали не срочные сигналы (за последнюю минуту) */
  private calmPlayed: number[] = [];
  private prevUlt: UltState | undefined = undefined;

  /** Новый тик: что прозвучит сейчас (не больше одного сигнала) */
  tick(t: SoundTick): SoundCueId | null {
    const fresh = new Set<SoundCueId>();
    for (const h of t.shown) {
      const c = cueForHint(h);
      if (c) fresh.add(c);
    }
    // Ульта: «перезарядка → готова» или «только что изучена»; первый снимок — только запомнить
    const prev = this.prevUlt;
    this.prevUlt = t.inGame ? t.ult : undefined;
    if (t.inGame && t.ult === 'ready' && (prev === 'cooldown' || prev === 'unlearned')) fresh.add('ult');

    for (const cue of fresh) {
      if (!t.enabled.has(cue)) continue;
      if (t.inFight && !cueInFight(cue)) continue;
      if (this.pending.some((p) => p.cue === cue)) continue;
      this.pending.push({ cue, atMs: t.nowMs });
    }
    this.pending = this.pending.filter((p) => t.nowMs - p.atMs <= SOUND_MAX_AGE_MS && t.enabled.has(p.cue) && (!t.inFight || cueInFight(p.cue)));
    if (!this.pending.length || t.nowMs - this.lastAnyMs < SOUND_MIN_GAP_MS) return null;
    // Кулдаун сигнала: на кулдауне — не звучит и не ждёт
    this.pending = this.pending.filter((p) => t.nowMs - (this.lastPlayed.get(p.cue) ?? -Infinity) >= SOUND_CUES[p.cue].cooldownMs);
    // Лимит не срочных за минуту: исчерпан — не срочные выбрасываются (подсказка на экране всё равно есть)
    this.calmPlayed = this.calmPlayed.filter((ms) => t.nowMs - ms < 60_000);
    if (this.calmPlayed.length >= SOUND_CALM_PER_MIN) this.pending = this.pending.filter((p) => cueInFight(p.cue));
    const next = [...this.pending].sort((a, b) => cuePriority(b.cue) - cuePriority(a.cue) || a.atMs - b.atMs)[0];
    if (!next) return null;
    this.pending = this.pending.filter((p) => p !== next);
    this.lastPlayed.set(next.cue, t.nowMs);
    this.lastAnyMs = t.nowMs;
    if (!cueInFight(next.cue)) this.calmPlayed.push(t.nowMs);
    return next.cue;
  }
}

/** Все сигналы, включённые в настройках */
export function enabledCues(cues: Partial<Record<SoundCueId, boolean>>): Set<SoundCueId> {
  return new Set(SOUND_CUE_IDS.filter((id) => cues[id] !== false));
}

/** Состояние ульты своего героя по снимку коуча (пассивная — null: нажимать нечего) */
export function ultStateOf(v: { me: { abilities: readonly { ultimate: boolean; level: number | null; passive?: boolean | null; state?: string | null; cooldownSec: number | null }[] } } | null): UltState {
  const ult = v?.me.abilities.find((a) => a.ultimate);
  if (!ult || ult.level === null || ult.passive === true) return null;
  if (ult.level === 0) return 'unlearned';
  if (ult.state === 'cooldown' || (ult.state !== 'ready' && (ult.cooldownSec ?? 0) > 0)) return 'cooldown';
  if (ult.state === 'ready' || (ult.state == null && ult.cooldownSec === 0)) return 'ready';
  return 'other';
}

// Достижения — только за исправленные ошибки и выполненные фокусы, по данным матчей. Каждое проверяется по
// записям матчей (по времени, старые первыми); получено — навсегда. Добавить — запись в ACHIEVEMENTS. Чистое ядро.
import { IMPROVE_WINDOW, mistakeWindows } from './xp.ts';
import { streakOf } from './streak.ts';
import type { MatchRecord } from './types.ts';

export interface AchievementDef {
  id: string;
  title: string;
  /** Как получить — по-русски, коротко */
  how: string;
  /** Выполнено на этих матчах (последний — текущий) */
  check(records: readonly MatchRecord[]): boolean;
}

/** n последних матчей подряд, где метрика есть и подходит */
function lastN(records: readonly MatchRecord[], n: number, ok: (r: MatchRecord) => boolean | null): boolean {
  const withData = records.filter((r) => ok(r) !== null);
  if (withData.length < n) return false;
  return withData.slice(-n).every((r) => ok(r) === true);
}

const metric = (id: string, test: (v: number) => boolean) => (r: MatchRecord) => (typeof r.metrics[id] === 'number' ? test(r.metrics[id]!) : null);

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'careful-5', title: 'Осторожный', how: '5 матчей подряд меньше 3 смертей до 10 минут', check: (rs) => lastN(rs, 5, metric('deaths-early', (v) => v < 3)) },
  { id: 'nothing-wasted-3', title: 'Ничего не сгорело', how: '3 матча подряд без смертей с готовыми, но не нажатыми предметами и способностями', check: (rs) => lastN(rs, 3, (r) => (r.mistakes['died-unused'] ?? 0) === 0) },
  { id: 'tp-5', title: 'Всегда на связи', how: '5 матчей подряд с Town Portal Scroll не меньше 90% времени', check: (rs) => lastN(rs, 5, metric('tp-always', (v) => v >= 90)) },
  { id: 'no-idle-5', title: 'Без простоев', how: '5 матчей подряд не больше одного простоя', check: (rs) => lastN(rs, 5, metric('no-idle', (v) => v <= 1)) },
  { id: 'focus-3', title: 'Серия', how: '3 фокуса матча подряд', check: (rs) => streakOf(rs).current >= 3 },
  { id: 'focus-10', title: 'Десять целей', how: '10 выполненных фокусов матча', check: (rs) => rs.filter((r) => r.focus?.achieved === true).length >= 10 },
  {
    id: 'fixed-mistake',
    title: 'Работа над ошибками',
    how: `Одна из ошибок стала вдвое реже: ${IMPROVE_WINDOW} последних матчей против ${IMPROVE_WINDOW} до них`,
    check: (rs) => {
      const i = rs.length - 1;
      const types = new Set(rs.flatMap((r) => Object.keys(r.mistakes)));
      return [...types].some((t) => {
        const w = mistakeWindows(rs, i, t);
        return !!w && w.prev >= 1 && w.last <= w.prev / 2;
      });
    },
  },
  {
    id: 'retreat-10',
    title: 'Вовремя ушёл',
    how: '10 раз отошли по совету «Отходи» и выжили',
    check: (rs) => rs.flatMap((r) => r.outcomes).filter((o) => o.survived !== null && o.result === 'acted' && o.survived).length >= 10,
  },
];

/** Какие достижения получены впервые на последнем матче (раньше не были) */
export function newAchievements(records: readonly MatchRecord[], earned: ReadonlySet<string>): AchievementDef[] {
  return ACHIEVEMENTS.filter((a) => !earned.has(a.id) && a.check(records));
}

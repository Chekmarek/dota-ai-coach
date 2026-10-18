// Профиль игрока (ночная задача, этап 4): повторяющиеся ошибки из локальной истории коуча (<папка данных>/history —
// разборы смертей, ошибки, сравнение с сильными игроками). Повтор — если ошибка была хотя бы в половине последних
// матчей (и минимум в двух). Коуч напоминает о ней в начале матча и дописывает к подсказке в тот момент, когда
// ситуация повторяется. Чистое ядро: файлы читает main.
import type { HistoryMatch } from '../../shared/types/history.ts';

export type PatternId = 'laning-deaths' | 'outnumbered' | 'position' | 'unused' | 'missed-fights' | 'unspent-gold' | 'low-farm';

export interface ProfilePattern {
  id: PatternId;
  /** В скольких матчах из скольких */
  inMatches: number;
  of: number;
  /** «смерти в меньшинстве» — для «Из прошлых игр: …» */
  titleRu: string;
  /** Что делать — в напоминании в начале матча */
  adviceRu: string;
}

export interface PlayerProfile {
  matches: number;
  patterns: ProfilePattern[];
}

export const PROFILE_MATCHES = 10;
export const PROFILE_MIN_MATCHES = 3;

const TITLE: Record<PatternId, { title: string; advice: string }> = {
  'laning-deaths': { title: 'смерти в лайнинге', advice: 'До конца лайнинга держитесь ближе к своей башне и следите за пропавшими врагами.' },
  outnumbered: { title: 'смерти в меньшинстве', advice: 'Перед тем как зайти, посчитайте врагов на мини-карте: больше, чем вас, — отходите.' },
  position: { title: 'смерти на стороне врага без обзора', advice: 'Без обзора не заходите на половину врага, когда враги пропали с карты.' },
  unused: { title: 'смерти с ненажатыми предметами и способностями', advice: 'Спасительные предметы и способности нажимайте в начале драки.' },
  'missed-fights': { title: 'драки команды без вас', advice: 'Смотрите на мини-карту: когда у союзника 2+ врага — идите или телепортируйтесь.' },
  'unspent-gold': { title: 'золото долго не тратилось', advice: 'Покупайте предмет сразу, как хватает золота, — курьером.' },
  'low-farm': { title: 'мало фарма по сравнению с сильными игроками', advice: 'Не пропускайте волны между драками: волна, лагерь, снова волна.' },
};

const CONSUMABLE = /Tango|Healing Salve|Clarity|Enchanted Mango/;

/** Ошибки одного матча: какие повторы в нём были */
function patternsOf(m: HistoryMatch): Set<PatternId> {
  const out = new Set<PatternId>();
  const turbo = m.gameMode?.mode === 'turbo';
  const laningEnd = turbo ? 300 : 600;
  for (const d of m.deathReviews) {
    const why = d.why.join(' ');
    if (d.clock !== null && d.clock < laningEnd) out.add('laning-deaths');
    // старый формат (до 0.13.8) не сравнивал с союзниками: «поймали 2 врага» бывало и при союзниках рядом — берём от 3
    if (/меньшинстве|Вас поймали ([3-9]|1\d) /.test(why)) out.add('outnumbered');
    if (/Позиция:|Смерть на стороне врага/.test(why)) out.add('position');
    // расходники как «не нажат» — старая ошибка коуча (до 0.13.7), не ошибка игрока
    if (/не нажат|не использован/.test(why) && !CONSUMABLE.test(why)) out.add('unused');
  }
  const after = m.mistakes.filter((x) => x.clock === null || x.clock >= laningEnd);
  if (after.filter((x) => x.type === 'missed-fight').length >= 2) out.add('missed-fights');
  if (m.mistakes.some((x) => x.type === 'unspent-gold')) out.add('unspent-gold');
  if (m.mistakes.some((x) => x.type === 'overextended')) out.add('position');
  if (m.entries.some((e) => e.id === 'laning.bench' && /у сильных игроков|у профи/.test(e.text))) out.add('low-farm');
  return out;
}

/** Профиль по последним матчам (новые — первыми); меньше PROFILE_MIN_MATCHES матчей — без повторов */
export function buildPlayerProfile(recent: readonly HistoryMatch[]): PlayerProfile {
  const ms = recent.slice(0, PROFILE_MATCHES);
  if (ms.length < PROFILE_MIN_MATCHES) return { matches: ms.length, patterns: [] };
  const counts = new Map<PatternId, number>();
  for (const m of ms) for (const p of patternsOf(m)) counts.set(p, (counts.get(p) ?? 0) + 1);
  const need = Math.max(2, Math.ceil(ms.length / 2));
  const patterns = [...counts.entries()]
    .filter(([, n]) => n >= need)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]): ProfilePattern => ({ id, inMatches: n, of: ms.length, titleRu: TITLE[id].title, adviceRu: TITLE[id].advice }));
  return { matches: ms.length, patterns };
}

/** «Так было в 4 из 5 последних матчей» — для подсказки в момент, когда ситуация повторяется; '' — не повтор */
export function personalNote(profile: PlayerProfile | null | undefined, id: PatternId): string {
  const p = profile?.patterns.find((x) => x.id === id);
  return p ? ` Из прошлых игр: ${p.titleRu} — в ${p.inMatches} из ${p.of} последних матчей.` : '';
}

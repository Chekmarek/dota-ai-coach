// Факты драфта для ИИ: только то, что посчитали правила (suggestHeroes, угрозы), в виде коротких строк.
// Модель пересказывает их и не может добавить ни героя, ни числа: проверка ответа (src/core/ai/grounding.ts)
// сверяет числа именно с этими строками.
import { pctRu, type DraftCandidate } from './suggest.ts';
import type { ThreatReport } from './threats.ts';

export interface DraftFactsInput {
  candidates: readonly DraftCandidate[];
  /** Имя героя по ключу (база знаний) */
  name: (key: string) => string;
  enemies: readonly string[];
  allies: readonly string[];
  position: number | null;
  patch: string | null;
  /** Дата статистики (ISO) */
  statsAt: string | null;
  threats?: readonly ThreatReport[];
  /** Название предмета по ключу */
  itemName?: (key: string) => string;
  /** Сколько кандидатов отдать модели */
  top?: number;
}

const POS_RU = ['керри (1)', 'мид (2)', 'оффлейн (3)', 'частичная поддержка (4)', 'полная поддержка (5)'];
/** «1 игра», «1 902 игры», «13 200 игр» */
export function gamesRu(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'игра' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'игры' : 'игр';
  return `${n.toLocaleString('ru-RU')} ${w}`;
}
const games = gamesRu;

export function draftFacts(i: DraftFactsInput): string[] {
  const out: string[] = [];
  out.push(`Источник: статистика публичных матчей OpenDota, патч ${i.patch ?? 'неизвестен'}${i.statsAt ? `, от ${i.statsAt.slice(0, 10)}` : ''}. Проценты — оценка изменения шанса победы, не гарантия.`);
  if (i.enemies.length) out.push(`Враги: ${i.enemies.map(i.name).join(', ')}.`);
  if (i.allies.length) out.push(`Союзники: ${i.allies.map(i.name).join(', ')}.`);
  if (i.position) out.push(`Позиция игрока: ${POS_RU[i.position - 1]}.`);
  i.candidates.slice(0, i.top ?? 3).forEach((c, n) => {
    const parts: string[] = [];
    for (const v of c.vsEnemies.filter((x) => Math.abs(x.delta) >= 0.001)) parts.push(`против ${i.name(v.hero)} ${pctRu(v.delta)} (${games(v.games)})`);
    for (const v of c.withAllies.filter((x) => Math.abs(x.delta) >= 0.001)) parts.push(`в связке с ${i.name(v.hero)} ${pctRu(v.delta)} (${games(v.games)})`);
    if (Math.abs(c.meta) >= 0.001) parts.push(`сила в патче ${pctRu(c.meta)}`);
    out.push(`Кандидат ${n + 1}: ${c.name}, итог ${pctRu(c.score)}${parts.length ? `: ${parts.join('; ')}` : ''}.`);
  });
  for (const t of i.threats ?? []) {
    const items = i.itemName ? t.threat.items.map((x) => i.itemName!(x.key)).join(', ') : '';
    out.push(`Угроза врагов — ${t.threat.nameRu} (${t.heroes.map(i.name).join(', ')}): ${t.threat.whyRu}${items ? `; против неё: ${items}` : ''}.`);
  }
  return out;
}

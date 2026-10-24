// Прогресс игрока в main: файл <папка данных>/progress.json (записи матчей, опыт, достижения), запись законченного
// матча из «Истории советов» и досчёт старых матчей из истории при первом запуске. Всё локально.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { addMatch, emptyProgress, progressView, type MatchRecord, type ProgressAward, type ProgressState, type ProgressView } from '@core/progress/index.ts';
import type { HistoryMatch } from '@shared/types/history';
import { focusHistory } from './focus';

/** Законченный матч из истории → запись для прогресса; не закончен (нет разбора матча) — null */
export function recordFromHistory(m: HistoryMatch): MatchRecord | null {
  if (!m.matchReview) return null;
  const mistakes: Record<string, number> = {};
  for (const x of m.mistakes) mistakes[x.type] = (mistakes[x.type] ?? 0) + 1;
  // метрики фокусов (у старых матчей — что можно восстановить: смерти до 10 мин, добивания к 10:00)
  const metrics = focusHistory([m])[0]?.metrics ?? {};
  return {
    key: m.id,
    startedAt: m.startedAt,
    turbo: m.gameMode?.mode === 'turbo',
    focus: m.focus ? { id: m.focus.id, achieved: m.focus.achieved } : null,
    metrics: { ...metrics },
    mistakes,
    outcomes: (m.hintOutcomes ?? []).map((o) => ({ type: o.type, short: o.short, result: o.result, survived: o.survived })),
  };
}

const outcome = z.object({ type: z.string().max(80), short: z.string().max(80), result: z.enum(['acted', 'ignored', 'unclear']), survived: z.boolean().nullable() });
const record = z.object({
  key: z.string().max(100),
  startedAt: z.string().max(40),
  turbo: z.boolean(),
  focus: z.object({ id: z.string().max(40), achieved: z.boolean().nullable() }).nullable(),
  metrics: z.record(z.string().max(40), z.number()),
  mistakes: z.record(z.string().max(40), z.number().int().min(0)),
  outcomes: z.array(outcome).max(500),
});
const item = z.object({ reason: z.enum(['focus', 'streak', 'hint', 'improved']), xp: z.number().int().min(0).max(1000), label: z.string().max(200) });
const schema = z.object({
  version: z.literal(1),
  records: z.array(record).max(5000),
  awards: z.array(z.object({ key: z.string().max(100), items: z.array(item).max(50), total: z.number().int().min(0) })).max(5000),
  achievements: z.record(z.string().max(40), z.object({ at: z.string().max(40), matchKey: z.string().max(100) })),
});

export class ProgressStore {
  readonly file: string;
  private state: ProgressState;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'progress.json');
    this.state = this.load();
  }

  private load(): ProgressState {
    if (!existsSync(this.file)) return emptyProgress();
    try {
      const r = schema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      return r.success ? (r.data as ProgressState) : emptyProgress();
    } catch {
      return emptyProgress();
    }
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** Законченный матч: опыт и достижения; уже учтён или не закончен — null */
  addMatch(m: HistoryMatch): ProgressAward | null {
    const rec = recordFromHistory(m);
    if (!rec) return null;
    const r = addMatch(this.state, rec, new Date().toISOString());
    if (!r) return null;
    this.state = r.state;
    this.save();
    return r.award;
  }

  /** Старые матчи из истории, которых ещё нет в прогрессе (первый запуск 0.20): по времени, старые первыми */
  backfill(history: readonly HistoryMatch[]): number {
    let n = 0;
    for (const m of [...history].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      const rec = recordFromHistory(m);
      if (!rec) continue;
      const r = addMatch(this.state, rec, m.startedAt);
      if (!r) continue;
      this.state = r.state;
      n++;
    }
    if (n) this.save();
    return n;
  }

  view(): ProgressView {
    return progressView(this.state);
  }
}

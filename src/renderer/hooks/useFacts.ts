import { useCallback } from 'react';
import { assembleFacts, type AiFacts, type AiPage } from '@core/ai/facts.ts';
import { LIVE_KIND } from '@shared/types/capture';
import { engine } from './useEngine';
import { useKnowledgeBase } from './useKnowledgeBase';
import { useGsi } from './useGsi';
import { currentGameMode } from '../components/gsi';
import { parseModeOverrides } from '@core/knowledge-base/modes.ts';
import turboJson from '../../data/modes/turbo.json';

/** Справочник Турбо для фактов ИИ (тот же, что у движка подсказок) */
const TURBO = parseModeOverrides(turboJson);

/**
 * Сборщик фактов для «Спросить» на странице: текущая модель матча (живая игра или «Разбор записи» — по источнику),
 * база знаний и то, что дополнительно показывает страница. Факты собираются в момент вопроса.
 */
export function usePageFacts(page: AiPage, extra?: () => string[], withMatch = true): (question: string) => AiFacts {
  const { kb } = useKnowledgeBase();
  const gsi = useGsi();
  return useCallback(
    (question: string) => {
      const match = withMatch ? engine.match : null;
      const kind = engine.status?.sourceKind ?? null;
      const replay = page === 'replay' || (kind !== null && kind !== LIVE_KIND && !match?.sources.gsi);
      // Режим игры — только для живой игры (у записи режим неизвестен)
      const mode = replay ? null : currentGameMode(gsi, Date.now());
      return assembleFacts({ page, question, match, replay, kb, extra: extra?.(), mode, turbo: TURBO });
    },
    [page, extra, withMatch, kb, gsi],
  );
}

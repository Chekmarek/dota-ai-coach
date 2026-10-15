import { useCallback } from 'react';
import { assembleFacts, type AiFacts, type AiPage } from '@core/ai/facts.ts';
import { LIVE_KIND } from '@shared/types/capture';
import { engine } from './useEngine';
import { useKnowledgeBase } from './useKnowledgeBase';

/**
 * Сборщик фактов для «Спросить» на странице: текущая модель матча (живая игра или «Разбор записи» — по источнику),
 * база знаний и то, что дополнительно показывает страница. Факты собираются в момент вопроса.
 */
export function usePageFacts(page: AiPage, extra?: () => string[], withMatch = true): (question: string) => AiFacts {
  const { kb } = useKnowledgeBase();
  return useCallback(
    (question: string) => {
      const match = withMatch ? engine.match : null;
      const kind = engine.status?.sourceKind ?? null;
      const replay = page === 'replay' || (kind !== null && kind !== LIVE_KIND && !match?.sources.gsi);
      return assembleFacts({ page, question, match, replay, kb, extra: extra?.() });
    },
    [page, extra, withMatch, kb],
  );
}

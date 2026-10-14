import { useEffect, useState } from 'react';
import type { KnowledgeBase } from '@shared/types/kb';

// База знаний загружается один раз на всё приложение: она не меняется, пока программа запущена
let cache: KnowledgeBase | null = null;
let pending: Promise<KnowledgeBase | { error: string }> | null = null;

export function useKnowledgeBase(): { kb: KnowledgeBase | null; error: string | null } {
  const [kb, setKb] = useState<KnowledgeBase | null>(cache);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (cache) return;
    let alive = true;
    pending ??= window.dotacoach.getKnowledgeBase();
    void pending.then((r) => {
      if ('error' in r) {
        pending = null;
        if (alive) setError(r.error);
      } else {
        cache = r;
        if (alive) setKb(r);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return { kb, error };
}

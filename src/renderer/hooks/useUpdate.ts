import { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/ipc';

// Состояние обновлений — одно на всё приложение (из обновления 0.5.0)
let updateCache: UpdateState | null = null;
const updateSubs = new Set<(s: UpdateState) => void>();
let updateWired = false;

export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(updateCache);
  useEffect(() => {
    updateSubs.add(setState);
    const api = window.dotacoach;
    if (!updateWired && api?.onUpdateState) {
      updateWired = true;
      const apply = (s: UpdateState) => {
        updateCache = s;
        updateSubs.forEach((fn) => fn(s));
      };
      api.onUpdateState(apply);
      void api.getUpdateState().then(apply);
    }
    return () => {
      updateSubs.delete(setState);
    };
  }, []);
  return state;
}

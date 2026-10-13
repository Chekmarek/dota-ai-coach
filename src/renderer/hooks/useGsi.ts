import { useEffect, useState } from 'react';
import type { GsiState } from '@shared/ipc';

// Состояние данных из игры (GSI) — одно на всё приложение, main присылает изменения сам
let cache: GsiState | null = null;
const subs = new Set<(s: GsiState) => void>();
let wired = false;

export function setGsiState(s: GsiState): void {
  cache = s;
  subs.forEach((fn) => fn(s));
}

export function useGsi(): GsiState | null {
  const [state, setState] = useState<GsiState | null>(cache);
  useEffect(() => {
    subs.add(setState);
    const api = window.dotacoach;
    if (!wired && api?.onGsiState) {
      wired = true;
      api.onGsiState(setGsiState);
      void api.getGsiState().then(setGsiState);
    }
    return () => {
      subs.delete(setState);
    };
  }, []);
  return state;
}

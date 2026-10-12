import { useCallback, useEffect, useState } from 'react';
import type { Settings, SettingsPatch } from '@shared/schemas/settings';
import type { AppInfo } from '@shared/ipc';

let cache: Settings | null = null;
const subs = new Set<(s: Settings) => void>();

export function useSettings(): { settings: Settings | null; update: (p: SettingsPatch) => Promise<void>; error: string | null } {
  const [settings, setSettings] = useState<Settings | null>(cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    subs.add(setSettings);
    if (!cache) {
      void window.dotacoach.getSettings().then((s) => {
        cache = s;
        subs.forEach((fn) => fn(s));
      });
    }
    return () => {
      subs.delete(setSettings);
    };
  }, []);

  const update = useCallback(async (patch: SettingsPatch) => {
    try {
      const s = await window.dotacoach.updateSettings(patch);
      cache = s;
      setError(null);
      subs.forEach((fn) => fn(s));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  return { settings, update, error };
}

export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void window.dotacoach.getAppInfo().then(setInfo);
  }, []);
  return info;
}

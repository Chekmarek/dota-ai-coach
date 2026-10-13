// Переключатели live-подсказок (решение владельца 2026-10-13, docs/POLICY.md).
// Одни и те же переключатели — в «Настройках» и на странице «Живая игра»; сохраняются сразу в settings.hints.
import type { Settings, SettingsPatch } from '@shared/schemas/settings';

export function HintsToggles({ settings, update, testIdPrefix = 'setting-hints' }: { settings: Settings; update: (p: SettingsPatch) => Promise<void>; testIdPrefix?: string }) {
  const h = settings.hints;
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={h.enabled} onChange={(e) => void update({ hints: { enabled: e.target.checked } })} data-testid={`${testIdPrefix}-enabled`} />
        Включить live-подсказки во время матча
      </label>
      <label className="check" title={h.enabled ? undefined : 'Сначала включите live-подсказки'}>
        <input type="checkbox" checked={h.ranked} disabled={!h.enabled} onChange={(e) => void update({ hints: { ranked: e.target.checked } })} data-testid={`${testIdPrefix}-ranked`} />
        Подсказки и в рейтинговых матчах
      </label>
      <p className="warn small" data-testid={`${testIdPrefix}-warning`}>
        Правила Valve о программах-подсказчиках во время матча не проверены. Использование, особенно в рейтинге, — на ваш риск: возможна блокировка аккаунта.
      </p>
    </>
  );
}

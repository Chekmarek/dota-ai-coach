// «Звуковые сигналы»: включение, громкость, каждый сигнал по отдельности с «Прослушать», горячая клавиша.
// Сами сигналы — src/core/sound/cues.ts, синтез — src/renderer/sound/player.ts.
import { useEffect, useState } from 'react';
import { SOUND_SHORTCUT_DEFAULT, acceleratorOf, isSafeBadAdviceShortcut, type Settings, type SettingsPatch } from '@shared/schemas/settings';
import { SOUND_CUES, SOUND_CUE_IDS } from '@core/sound/cues.ts';
import { useSettings } from '../hooks/useSettings';
import { Card, PageHeader } from '../components/ui';
import { playTone } from '../sound/player';

export function SoundSettings() {
  const { settings, update, error } = useSettings();
  if (!settings) return null;
  const s = settings.sound;
  return (
    <>
      <PageHeader title="Звуковые сигналы" subtitle="Короткие тихие звуки на важные моменты матча: у каждого смысла — свой звук." />
      <Card title="Общие">
        <div className="form">
          <label className="check">
            <input type="checkbox" checked={s.enabled} onChange={(e) => void update({ sound: { enabled: e.target.checked } })} data-testid="sound-enabled" />
            Включить звуковые сигналы
          </label>
          <label>
            Громкость: {Math.round(s.volume * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => void update({ sound: { volume: Number(e.target.value) } })} data-testid="sound-volume" />
          </label>
          <p className="muted small">
            Не чаще одного сигнала в 1,5 с; в драке звучит только «Опасность»; звук, который не успел прозвучать за 2 с, пропускается.
          </p>
          <SoundShortcutField settings={settings} update={update} />
        </div>
      </Card>
      <Card title="Сигналы">
        <ul className="sound-cues">
          {SOUND_CUE_IDS.map((id) => (
            <li key={id} className="sound-cue">
              <label className="check">
                <input type="checkbox" checked={s.cues[id]} disabled={!s.enabled} onChange={(e) => void update({ sound: { cues: { [id]: e.target.checked } } })} data-testid={`sound-cue-${id}`} />
                <b>{SOUND_CUES[id].nameRu}</b>
              </label>
              <span className="muted small">{SOUND_CUES[id].whenRu}</span>
              <button onClick={() => playTone(id, Math.max(s.volume, 0.05))} data-testid={`sound-try-${id}`}>
                Прослушать
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">«Прослушать» играет с текущей громкостью (при нуле — чуть слышно), даже если сигналы выключены.</p>
        {error && <p className="error">{error}</p>}
      </Card>
      <Card title="Можно добавить позже">
        <ul className="muted small">
          <li>Ключевая способность (не ульта) готова — в данных игры не отмечено, какая способность ключевая.</li>
          <li>Ключевой предмет снова готов после перезарядки (Black King Bar, Blink) — коуч это видит, но такой подсказки нет.</li>
          <li>Отдельный звук смерти — сейчас в момент смерти звучит «Разбор готов».</li>
        </ul>
      </Card>
    </>
  );
}

/** Клавиша «звук вкл/выкл»: как «плохой совет» — только безопасные сочетания и не то же самое */
function SoundShortcutField({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => Promise<void> }) {
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<{ key: string; bound: boolean } | null>(null);
  const value = settings.sound.shortcut;
  useEffect(() => {
    void window.dotacoach.soundShortcutStatus().then(setStatus);
  }, [value, settings.hints.badAdviceShortcut]);
  return (
    <>
      <label>
        Клавиша «звук вкл/выкл»
        <input
          readOnly
          value={value || 'выключена'}
          data-testid="sound-shortcut"
          onKeyDown={(e) => {
            if (e.key === 'Tab') return;
            e.preventDefault();
            const acc = acceleratorOf(e);
            if (!acc) return setHint('Нажмите сочетание: Ctrl/Alt + F1…F12, или два модификатора + буква/цифра.');
            if (!isSafeBadAdviceShortcut(acc)) return setHint(`${acc} не подходит: нужен Ctrl или Alt, а с буквой или цифрой — два модификатора.`);
            if (acc === settings.hints.badAdviceShortcut) return setHint(`${acc} уже занято клавишей «плохой совет».`);
            setHint(null);
            void update({ sound: { shortcut: acc } });
          }}
        />
      </label>
      <p className="muted small">
        Работает и во время игры: включает и выключает все сигналы и подтверждает это коротким звуком.{' '}
        <button className="link" onClick={() => void update({ sound: { shortcut: SOUND_SHORTCUT_DEFAULT } })}>
          По умолчанию ({SOUND_SHORTCUT_DEFAULT})
        </button>{' '}
        <button className="link" onClick={() => void update({ sound: { shortcut: '' } })} data-testid="sound-shortcut-off">
          Выключить
        </button>
      </p>
      {status && value && status.key === value && !status.bound && (
        <p className="warn small" data-testid="sound-shortcut-busy">
          Сочетание {value} занято другой программой — выберите другое.
        </p>
      )}
      {hint && <p className="warn small">{hint}</p>}
    </>
  );
}

/** Индикатор в боковой панели: звук включён или выключен; щелчок — переключить */
export function SoundPill() {
  const { settings, update } = useSettings();
  if (!settings) return null;
  const on = settings.sound.enabled;
  const key = settings.sound.shortcut;
  return (
    <button
      className={`pill sound-pill ${on ? 'sound-on' : 'sound-off'}`}
      title={`Звуковые сигналы ${on ? 'включены' : 'выключены'}${key ? ` (${key})` : ''} — щёлкните, чтобы переключить`}
      onClick={() => {
        playTone(on ? 'toggle-off' : 'toggle-on', settings.sound.volume);
        void update({ sound: { enabled: !on } });
      }}
      data-testid="sound-indicator"
      data-on={on ? '1' : '0'}
    >
      {on ? 'Звук вкл' : 'Звук выкл'}
    </button>
  );
}

// «Настройки» в виде разделов — из обновления 0.5.0 (ключи settings.json не менялись).
import type { ReactNode } from 'react';
import type { OverlayCorner, Settings, SettingsPatch } from '@shared/schemas/settings';
import { useAppInfo, useSettings } from '../hooks/useSettings';
import { useEngine } from '../hooks/useEngine';
import { useUpdate } from '../hooks/useUpdate';
import { PageHeader } from '../components/ui';
import { isLive, startLive } from '../components/live';
import { HintsToggles } from '../components/hints';
import type { PageProps } from './types';

/** Числовое поле настройки: сохраняется при уходе с поля, неверное значение откатывается */
function NumberSetting(props: { label: string; hint?: string; value: number; min: number; max: number; step: number; testId: string; onSave: (n: number) => void }) {
  const { label, hint, value, min, max, step, testId, onSave } = props;
  return (
    <label title={hint}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        key={value}
        data-testid={testId}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= min && n <= max) {
            if (n !== value) onSave(n);
          } else e.target.value = String(value);
        }}
      />
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}

function SettingsSection({ icon, title, subtitle, children }: { icon: string; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="card settings-section">
      <header className="settings-head">
        <span className="settings-icon" aria-hidden>
          {icon}
        </span>
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="muted small">{subtitle}</p>}
        </div>
      </header>
      <div className="form">{children}</div>
    </section>
  );
}

function LiveSettingsCard({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => Promise<void> }) {
  const l = settings.live;
  const { status } = useEngine();
  // Новая частота захвата применяется сразу, если коуч уже смотрит игру
  const saveFps = async (n: number) => {
    await update({ live: { fps: n } });
    if (isLive(status)) startLive({ ...settings, live: { ...l, fps: n } });
  };
  return (
    <SettingsSection icon="●" title="Живая игра" subtitle="Как коуч смотрит на окно Dota 2 и что показывает поверх игры.">
      <label className="check">
        <input type="checkbox" checked={l.autoStart} onChange={(e) => void update({ live: { autoStart: e.target.checked } })} data-testid="setting-live-autostart" />
        Включать захват сам при запуске коуча
      </label>
      <NumberSetting label="Кадров в секунду с окна игры" hint="10 — хороший баланс. Больше — плавнее, но выше нагрузка" value={l.fps} min={1} max={30} step={1} testId="setting-live-fps" onSave={(n) => void saveFps(n)} />
      <label className="check">
        <input type="checkbox" checked={l.overlay} onChange={(e) => void update({ live: { overlay: e.target.checked } })} data-testid="setting-live-overlay" />
        Показывать значок «Коуч» поверх игры
      </label>
      {l.overlay && (
        <label>
          Угол значка
          <select value={l.overlayCorner} onChange={(e) => void update({ live: { overlayCorner: e.target.value as OverlayCorner } })} data-testid="setting-live-corner">
            <option value="top-right">Справа сверху</option>
            <option value="top-left">Слева сверху</option>
            <option value="bottom-right">Справа снизу</option>
            <option value="bottom-left">Слева снизу</option>
          </select>
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={settings.ui.showRegions} onChange={(e) => void update({ ui: { showRegions: e.target.checked } })} data-testid="setting-show-regions" />
        Подсвечивать распознанные области HUD на картинке
      </label>
    </SettingsSection>
  );
}

export function AppSettings({ onNavigate }: PageProps) {
  const { settings, update, error } = useSettings();
  const info = useAppInfo();
  const upd = useUpdate();
  if (!settings) return null;
  const c = settings.capture;

  return (
    <>
      <PageHeader title="Настройки" subtitle="Всё сохраняется сразу." />
      {error && <p className="error">{error}</p>}
      <LiveSettingsCard settings={settings} update={update} />
      <SettingsSection icon="💬" title="Live-подсказки" subtitle="Советы коуча во время матча — в отдельном окне, не поверх игры. Решаете вы.">
        <HintsToggles settings={settings} update={update} />
      </SettingsSection>
      <SettingsSection icon="◆" title="Данные из игры (GSI)" subtitle="Dota присылает коучу данные о вашем герое на этот компьютер (127.0.0.1). Подключение — на странице «Живая игра».">
        <NumberSetting
          label="Порт приёмника"
          hint="Если порт занят другой программой — укажите другой (1024–65535). Файл в папке Dota обновится сам"
          value={settings.gsi.port}
          min={1024}
          max={65535}
          step={1}
          testId="setting-gsi-port"
          onSave={(n) => void update({ gsi: { port: Math.round(n) } })}
        />
        <label className="check">
          <input type="checkbox" checked={settings.gsi.record} onChange={(e) => void update({ gsi: { record: e.target.checked } })} data-testid="setting-gsi-record" />
          Записывать сессии (без ников и steamid; последние 20 дней, не больше 500 МБ — в папке данных, gsi-sessions)
        </label>
      </SettingsSection>
      <SettingsSection icon="▶" title="Разбор записей" subtitle="Для папки с кадрами и видеофайлов. Применяется при следующем запуске записи.">
        <NumberSetting label="Кадров в секунду из записи" hint="Сколько кадров в секунду брать из видео или папки" value={c.targetFps} min={0.2} max={30} step={0.1} testId="setting-targetFps" onSave={(n) => void update({ capture: { targetFps: n } })} />
        <NumberSetting label="Частота превью записи, к/с" hint="Как часто обновлять картинку на странице «Разбор записи»" value={c.previewFps} min={0.2} max={10} step={0.1} testId="setting-previewFps" onSave={(n) => void update({ capture: { previewFps: n } })} />
        <label className="check">
          <input type="checkbox" checked={settings.replay.loop} onChange={(e) => void update({ replay: { loop: e.target.checked } })} data-testid="setting-loop" />
          Повторять запись по кругу
        </label>
      </SettingsSection>
      <SettingsSection icon="⚡" title="Производительность" subtitle="Общее для живой игры и записей. Если коуч грузит компьютер — уменьшите эти значения.">
        <NumberSetting label="Лимит обработки, кадров/с" hint="Сколько кадров в секунду коуч разбирает. Лишние отбрасываются" value={c.processingFpsCap} min={0.2} max={30} step={0.1} testId="setting-processingFpsCap" onSave={(n) => void update({ capture: { processingFpsCap: n } })} />
        <NumberSetting label="Максимальная ширина кадра, px" hint="Большие кадры уменьшаются до этой ширины перед разбором (распознавание HUD настроено на 1920)" value={c.maxWidth} min={320} max={3840} step={1} testId="setting-maxWidth" onSave={(n) => void update({ capture: { maxWidth: n } })} />
      </SettingsSection>
      <SettingsSection icon="ℹ" title="О программе">
        {info && (
          <>
            <dl className="kv">
              <dt>Версия</dt>
              <dd data-testid="app-version">
                {info.version}
                {upd?.status === 'available' ? <span className="update-new"> · доступна {upd.latest?.version}</span> : upd?.status === 'up-to-date' ? <span className="muted"> · последняя</span> : null}
              </dd>
              <dt>Вариант</dt>
              <dd>{{ dev: 'разработка', installed: 'установленная', portable: 'портативная' }[info.distribution]}</dd>
              <dt>Папка данных</dt>
              <dd className="mono">{info.dataDir}</dd>
              <dt>Electron / Chromium / Node</dt>
              <dd className="mono">
                {info.electron} / {info.chrome} / {info.node}
              </dd>
            </dl>
            <div>
              <button onClick={() => onNavigate('updates')} data-testid="settings-open-updates">
                Обновления →
              </button>
            </div>
          </>
        )}
      </SettingsSection>
    </>
  );
}

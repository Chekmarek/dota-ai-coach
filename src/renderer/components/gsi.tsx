// Данные из игры (Valve GSI): статус, подключение файла в папке Dota, параметр запуска.
import { useEffect, useState } from 'react';
import type { GsiState } from '@shared/ipc';
import { setGsiState, useGsi } from '../hooks/useGsi';
import { Card } from './ui';
import { gameModeRu, UNKNOWN_MODE, type GameModeInfo } from '@core/gsi/mode.ts';

/**
 * Данные «идут», если последний запрос был не раньше этого. Настоящая Dota (проверка 2026-10-13) в меню присылает
 * один запрос при запуске и молчит, пока не загрузится матч или Hero Demo; в матче — при изменениях и не реже
 * heartbeat (30 с). Поэтому в меню статус «файл установлен, ждём Dota» — это норма.
 */
export const GSI_FLOW_MS = 35_000;

export type GsiStatusKey = 'port-busy' | 'error' | 'flowing' | 'waiting' | 'off';

export function gsiStatus(st: GsiState | null, now: number): { key: GsiStatusKey; text: string } {
  if (!st) return { key: 'off', text: 'не подключено' };
  if (st.server === 'port-busy') return { key: 'port-busy', text: 'порт занят' };
  if (st.server === 'error') return { key: 'error', text: 'ошибка приёмника' };
  if (st.lastBodyAt !== null && now - st.lastBodyAt < GSI_FLOW_MS) {
    const s = Math.max(0, Math.round((now - st.lastBodyAt) / 1000));
    return { key: 'flowing', text: `данные идут · ${s} с назад` };
  }
  if (st.dota.installed) return { key: 'waiting', text: 'файл установлен, ждём Dota' };
  return { key: 'off', text: 'не подключено' };
}

/** Текущее время раз в секунду — для «N с назад» */
export function useTick(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Режим игры сейчас: ручной выбор — всегда; из игры — только пока данные идут, иначе «режим неизвестен» */
export function currentGameMode(st: GsiState | null, now: number): GameModeInfo {
  if (!st?.gameMode) return { ...UNKNOWN_MODE };
  if (st.gameMode.source === 'manual') return st.gameMode;
  return st.lastBodyAt !== null && now - st.lastBodyAt < GSI_FLOW_MS ? st.gameMode : { ...UNKNOWN_MODE };
}

/** Подпись «Турбо» / «All Pick» / «режим неизвестен» */
export function GameModeBadge({ testId = 'game-mode' }: { testId?: string }) {
  const mode = currentGameMode(useGsi(), useTick());
  const title =
    mode.source === 'manual'
      ? 'Режим выбран вручную: «Настройки → Live-подсказки → Режим игры»'
      : mode.mode === 'unknown'
        ? 'Dota не сообщила режим (нет данных из игры или в них нет режима). Подсказки — как в обычной игре; режим можно выбрать вручную в «Настройках»'
        : `По данным игры${mode.raw ? `: ${mode.raw}` : ''}`;
  return (
    <span className={`pill game-mode game-mode-${mode.mode}`} data-testid={testId} data-mode={mode.mode} title={title}>
      {gameModeRu(mode)}
    </span>
  );
}

/** Плашка для боковой панели: видна, только когда данные идут */
export function GsiSidebarPill() {
  const st = useGsi();
  const now = useTick();
  const s = gsiStatus(st, now);
  if (s.key !== 'flowing') return null;
  return (
    <span className="pill gsi-pill gsi-flowing" data-testid="sidebar-gsi" title="Dota присылает данные о матче (Game State Integration)">
      Данные из игры
    </span>
  );
}

export function GsiCard() {
  const st = useGsi();
  const now = useTick();
  const [confirm, setConfirm] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const s = gsiStatus(st, now);

  const run = async (fn: () => Promise<GsiState>) => {
    setError(null);
    try {
      setGsiState(await fn());
    } catch (e) {
      setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setConfirm(null);
    }
  };

  const copy = async () => {
    await window.dotacoach.copyGsiLaunchOption();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const dota = st?.dota;
  const outdated = dota?.installed && !dota.current;
  const upToDate = !!(dota?.installed && dota.current);
  // Коуч сам переписал устаревший файл — Dota подхватит его после перезапуска (пока данные не пошли снова)
  const refreshedAt = dota?.refreshedAt ?? null;
  const lastBodyAt = st?.lastBodyAt ?? null;
  const refreshed = refreshedAt !== null && (lastBodyAt === null || lastBodyAt < refreshedAt);
  return (
    <Card
      title="Данные из игры (GSI)"
      actions={
        <>
          <button
            className="primary"
            onClick={() => setConfirm('connect')}
            disabled={!st || !dota?.cfgPath || upToDate}
            title={upToDate ? 'Файл коуча уже в папке Dota и совпадает с текущими настройками' : undefined}
            data-testid="gsi-connect"
          >
            {upToDate ? 'Файл установлен' : outdated ? 'Обновить файл' : 'Подключить'}
          </button>
          <button onClick={() => setConfirm('disconnect')} disabled={!dota?.installed} data-testid="gsi-disconnect">
            Отключить
          </button>
        </>
      }
    >
      <div className="row">
        <span className={`pill gsi-pill gsi-${s.key}`} data-testid="gsi-status" data-state={s.key}>
          {s.text}
        </span>
        {st && (
          <span className="muted small">
            127.0.0.1:{st.port} · принято {st.accepted}
            {st.rejected > 0 ? ` · отклонено ${st.rejected}` : ''}
            {st.recording ? ' · сессии записываются' : ''}
          </span>
        )}
      </div>
      <p className="muted small">
        Valve Game State Integration: Dota сама присылает коучу данные о вашем герое — время, золото, уровень, здоровье, способности,
        предметы. Точнее и быстрее, чем по картинке. Только чтение; коуч ничего не отправляет в игру.
      </p>
      {s.key === 'port-busy' && (
        <p className="error" data-testid="gsi-port-busy">
          Порт {st?.port} занят другой программой. Укажите другой порт в «Настройки → Данные из игры» — файл в папке Dota обновится сам.
        </p>
      )}
      {st?.error && <p className="error">Ошибка приёмника: {st.error}</p>}
      {outdated && <p className="warn">Файл в папке Dota от старых настроек — нажмите «Обновить файл».</p>}
      {refreshed && !outdated && (
        <p className="warn" data-testid="gsi-refreshed">
          Файл обновлён — перезапустите Dota, чтобы она его подхватила.
        </p>
      )}
      {s.key === 'waiting' && !refreshed && (
        <p className="muted small" data-testid="gsi-waiting-hint">
          В меню Dota данных не присылает — это нормально. Данные пойдут, когда загрузится матч или Hero Demo.
        </p>
      )}
      {dota && !dota.dir && (
        <p className="warn" data-testid="gsi-no-dota">
          Папка Dota 2 не найдена.{' '}
          <button className="link" onClick={() => void run(() => window.dotacoach.pickDotaFolder())} data-testid="gsi-pick-dota">
            Указать папку Dota
          </button>
        </p>
      )}
      {confirm && dota?.cfgPath && (
        <div className="gsi-confirm" role="dialog" data-testid="gsi-confirm">
          <strong>{confirm === 'connect' ? 'Записать файл в папку Dota?' : 'Удалить файл из папки Dota?'}</strong>
          <code className="mono" data-testid="gsi-confirm-path">
            {dota.cfgPath}
          </code>
          <span className="muted small">
            {confirm === 'connect'
              ? 'Только этот файл. Файлы Steam и игры коуч не меняет.'
              : 'Удаляется только этот файл коуча; остальное в папке не трогается.'}
          </span>
          <div className="row">
            <button
              className="primary"
              onClick={() => void run(() => (confirm === 'connect' ? window.dotacoach.connectGsi() : window.dotacoach.disconnectGsi()))}
              data-testid="gsi-confirm-yes"
            >
              {confirm === 'connect' ? 'Записать' : 'Удалить'}
            </button>
            <button onClick={() => setConfirm(null)} data-testid="gsi-confirm-no">
              Отмена
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="error" data-testid="gsi-error">
          {error}
        </p>
      )}
      <ol className="gsi-steps small">
        <li>Нажмите «Подключить» — коуч запишет свой файл в папку Dota.</li>
        <li>
          Steam → Библиотека → Dota 2 → Свойства → Параметры запуска: добавьте{' '}
          <code className="mono" data-testid="gsi-launch-option">
            {st?.launchOption ?? '-gamestateintegration'}
          </code>{' '}
          <button onClick={() => void copy()} data-testid="gsi-copy">
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </li>
        <li>Перезапустите Dota 2. Статус сменится на «данные идут», когда загрузится матч или Hero Demo (в меню Dota молчит).</li>
      </ol>
    </Card>
  );
}

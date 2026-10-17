// «ИИ-помощник» (0.11.0): кто отвечает (локальная модель на CPU, облако с ключом пользователя), скачивание
// локального ИИ, чат «Спроси коуча» и «Разбор матча» по записанным сессиям GSI.
// ИИ ничего не считает сам: он пересказывает факты коуча, числа в ответе сверяются с ними.
import { useEffect, useState } from 'react';
import type { AiDraftModel, AiLocalModel, Settings, SettingsPatch } from '@shared/schemas/settings';
import type { AiUiState } from '@shared/types/ai';
import type { GsiSessionInfo } from '@shared/ipc';
import { afterMatchFromGsi } from '@core/ai/after-match.ts';
import { mmss } from '@core/ai/facts.ts';
import { Card, PageHeader } from '../components/ui';
import { AskCoach, MatchSummary } from '../components/ask';
import { useSettings } from '../hooks/useSettings';
import { formatBytes, setAiState, useAiState } from '../hooks/useAi';
import { usePageFacts } from '../hooks/useFacts';
import type { PageProps } from './types';

const DL_STATUS: Record<string, string> = {
  downloading: 'Скачивается',
  verifying: 'Проверка SHA-256',
  extracting: 'Распаковка',
  done: 'Готово',
  error: 'Ошибка',
  idle: '',
};

function ProviderChoice({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => Promise<void> }) {
  const p = settings.ai.provider;
  const opt = (id: 'off' | 'local' | 'openai-compatible', title: string, note: string) => (
    <label className="radio-row">
      <input type="radio" name="ai-provider" checked={p === id} onChange={() => void update({ ai: { provider: id } })} data-testid={`ai-provider-${id}`} />
      <span>
        <strong>{title}</strong> <span className="muted small">{note}</span>
      </span>
    </label>
  );
  return (
    <Card title="Кто отвечает">
      <div className="form">
        {opt('off', 'Выключен', 'по умолчанию; коуч работает без ИИ')}
        {opt('local', 'Локальная модель на этом ПК', 'бесплатно, без интернета, работает на процессоре; нужно один раз скачать')}
        {opt('openai-compatible', 'Облако (OpenAI-совместимый сервер)', 'бесплатный ключ у любого сервиса с OpenAI-совместимым API; данные уходят в облако только с вашего согласия')}
        <label className="radio-row disabled" title="Недоступно">
          <input type="radio" name="ai-provider" disabled checked={p === 'gigachat'} data-testid="ai-provider-gigachat" />
          <span>
            <strong>GigaChat</strong>{' '}
            <span className="muted small">пока недоступен: для подключения нужен отдельный корневой сертификат Минцифры, коуч его в систему не устанавливает</span>
          </span>
        </label>
      </div>
    </Card>
  );
}

/**
 * Модель для выбора героев (Qwen3 8B): объясняет советы драфта, пока идёт выбор героев. В матче не используется —
 * при начале матча коуч её выгружает и отвечает обычной моделью выше.
 */
function DraftModelRow({ ai, settings, update, downloading }: { ai: AiUiState; settings: Settings; update: (p: SettingsPatch) => Promise<void>; downloading: boolean }) {
  const l = ai.local;
  const chosen = settings.ai.local.draftModel;
  const m = l.draftModels!.find((x) => x.id === chosen) ?? null;
  return (
    <div className="form" data-testid="ai-draft-model">
      <label>
        Модель для выбора героев
        <select
          value={chosen ?? ''}
          onChange={(e) => void update({ ai: { local: { draftModel: (e.target.value || null) as AiDraftModel | null } } })}
          disabled={downloading}
          data-testid="ai-draft-model-select"
        >
          <option value="">та же, что выше</option>
          {l.draftModels!.map((x) => (
            <option key={x.id} value={x.id}>
              {x.nameRu} — {formatBytes(x.sizeBytes)}
              {x.installed ? ' · скачана' : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        Только на время выбора героев: объясняет, кого брать. Когда начинается матч, коуч выгружает её и дальше отвечает моделью выше. Памяти нужно
        около 6 ГБ; на слабых ПК не проверено.
      </p>
      {m && !m.installed && (
        <button disabled={downloading} onClick={() => void window.dotacoach.downloadLocalAi(m.id).then(setAiState)} data-testid="ai-draft-download">
          ⬇ Скачать {m.nameRu} ({formatBytes(m.sizeBytes)})
        </button>
      )}
    </div>
  );
}

function LocalCard({ ai, settings, update }: { ai: AiUiState; settings: Settings; update: (p: SettingsPatch) => Promise<void> }) {
  const l = ai.local;
  const model = settings.ai.local.model;
  const m = l.models.find((x) => x.id === model)!;
  const need = (l.runtimeInstalled ? 0 : l.runtimeSizeBytes) + (m.installed ? 0 : m.sizeBytes);
  const d = l.download;
  const downloading = d.status === 'downloading' || d.status === 'verifying' || d.status === 'extracting';
  const ready = l.runtimeInstalled && m.installed;
  const sv = l.server;
  const act = async (fn: () => Promise<AiUiState>) => setAiState(await fn());
  return (
    <Card title="Локальный ИИ" actions={<span className={`pill ${ready ? 'pill-running' : 'pill-idle'}`} data-testid="ai-local-ready">{ready ? 'Скачан' : 'Не скачан'}</span>}>
      <div className="form">
        <label>
          Модель
          <select value={model} onChange={(e) => void update({ ai: { local: { model: e.target.value as AiLocalModel } } })} disabled={downloading} data-testid="ai-local-model">
            {l.models.map((x) => (
              <option key={x.id} value={x.id}>
                {x.nameRu} — {formatBytes(x.sizeBytes)}
                {x.installed ? ' · скачана' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          Работает на процессоре (видеокарта не нужна). Скачивается в папку данных коуча: сборка llama.cpp ({formatBytes(l.runtimeSizeBytes)}) и модель. Файлы
          проверяются по SHA-256. Памяти нужно примерно на 1 ГБ больше размера модели.
        </p>
        <div className="row">
          {downloading ? (
            <button onClick={() => void act(window.dotacoach.cancelLocalAiDownload)} data-testid="ai-download-cancel">
              ■ Остановить скачивание
            </button>
          ) : (
            <button className="primary" disabled={ready} onClick={() => void act(() => window.dotacoach.downloadLocalAi(model))} data-testid="ai-download">
              ⬇ Скачать локальный ИИ {need ? `(${formatBytes(need)})` : ''}
            </button>
          )}
          <button
            disabled={downloading || (!l.runtimeInstalled && !l.models.some((x) => x.installed))}
            onClick={() => {
              if (window.confirm('Удалить скачанные модели и llama.cpp? Скачать можно будет снова.')) void act(window.dotacoach.deleteLocalAi);
            }}
            data-testid="ai-delete"
          >
            Удалить
          </button>
        </div>
        {d.status !== 'idle' && d.status !== 'done' && (
          <div data-testid="ai-download-progress">
            <div className="muted small">
              {DL_STATUS[d.status]} {d.file ?? ''} {d.total ? `${formatBytes(d.received)} из ${formatBytes(d.total)}` : ''}
            </div>
            {d.total > 0 && <progress max={d.total} value={d.received} />}
            {d.error && <p className="error small">{d.error}</p>}
          </div>
        )}
        <div className="row small" data-testid="ai-local-stats">
          <span>
            Сервер: <strong>{{ stopped: 'остановлен', starting: 'загружается…', ready: 'работает', error: 'ошибка' }[sv.status]}</strong>
          </span>
          <span className="muted">загрузка модели: {sv.loadMs !== null ? `${(sv.loadMs / 1000).toFixed(1).replace('.', ',')} с` : '—'}</span>
          <span className="muted">скорость: {sv.tokensPerSec !== null ? `${String(sv.tokensPerSec).replace('.', ',')} токенов/с` : '—'}</span>
          <span className="muted">память: {formatBytes(sv.ramBytes)}</span>
          <span className="muted">потоков: {sv.threads ?? '—'}</span>
          {sv.status === 'ready' && <button className="small-btn" onClick={() => void act(window.dotacoach.stopLocalAi)}>Остановить</button>}
        </div>
        {sv.error && <p className="error small">{sv.error}</p>}
        <p className="muted small">
          Сервер запускается при первом вопросе с пониженным приоритетом и останавливается после 5 минут простоя. Во время матча ответы короче, чтобы не
          мешать игре.
        </p>
        {l.draftModels && l.draftModels.length > 0 && <DraftModelRow ai={ai} settings={settings} update={update} downloading={downloading} />}
      </div>
    </Card>
  );
}

function CloudCard({ ai, settings, update }: { ai: AiUiState; settings: Settings; update: (p: SettingsPatch) => Promise<void> }) {
  const c = settings.ai.cloud;
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // флажок отмечается сразу, сохранение в main — следом (без задержки на ответ IPC)
  const [consent, setConsent] = useState(settings.ai.sendToCloudConsent);
  useEffect(() => setConsent(settings.ai.sendToCloudConsent), [settings.ai.sendToCloudConsent]);
  const saveText = (field: 'baseUrl' | 'model', v: string) => {
    if (v === c[field]) return;
    void update({ ai: { cloud: { [field]: v.trim() } } }).catch((e: Error) => setErr(e.message));
  };
  return (
    <Card title="Облачный ИИ (по желанию)">
      <div className="form">
        <label>
          Адрес API (OpenAI-совместимый, оканчивается на /v1)
          <input defaultValue={c.baseUrl} key={c.baseUrl} placeholder="https://…/v1" onBlur={(e) => saveText('baseUrl', e.target.value)} data-testid="ai-cloud-url" />
        </label>
        <label>
          Модель
          <input defaultValue={c.model} key={c.model} placeholder="имя модели у сервиса" onBlur={(e) => saveText('model', e.target.value)} data-testid="ai-cloud-model" />
        </label>
        <label>
          Ключ доступа {ai.keys.openaiCompatible ? <span className="ok-text small">· сохранён</span> : <span className="muted small">· не задан</span>}
          <div className="row">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={ai.keys.openaiCompatible ? 'ключ сохранён — введите новый, чтобы заменить' : 'вставьте ключ'} autoComplete="off" data-testid="ai-cloud-key" />
            <button
              disabled={key.trim().length < 8 || !ai.encryption}
              onClick={() =>
                void window.dotacoach
                  .setAiKey(key.trim())
                  .then((s) => (setAiState(s), setKey(''), setErr(null)))
                  .catch((e: Error) => setErr(e.message))
              }
              data-testid="ai-cloud-key-save"
            >
              Сохранить
            </button>
            {ai.keys.openaiCompatible && <button onClick={() => void window.dotacoach.clearAiKey().then(setAiState)}>Удалить ключ</button>}
          </div>
          <span className="muted small">Ключ шифруется Windows и хранится только на этом ПК; в интерфейс и в журнал он не попадает.</span>
          {!ai.encryption && <span className="error small">Шифрование Windows недоступно — ключ сохранить нельзя.</span>}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              void update({ ai: { sendToCloudConsent: e.target.checked } });
            }}
            data-testid="ai-cloud-consent"
          />
          Согласен отправлять в облако вопрос и факты коуча (игровые данные без ников, без steamid и без ключей)
        </label>
        {err && <p className="error small">{err}</p>}
      </div>
    </Card>
  );
}

function SessionsCard() {
  const [list, setList] = useState<GsiSessionInfo[] | null>(null);
  const [sel, setSel] = useState<string>('');
  const [facts, setFacts] = useState<{ label: string; lines: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void window.dotacoach.listGsiSessions().then(setList, (e: Error) => setErr(e.message));
  }, []);
  async function open(id: string) {
    setSel(id);
    setFacts(null);
    if (!id) return;
    const r = await window.dotacoach.getGsiSessionMatch(id);
    if ('error' in r) return setErr(r.error);
    setErr(null);
    const f = afterMatchFromGsi(r.readings);
    setFacts({ label: `Матч ${r.info.day}${r.info.hero ? `, ${r.info.hero}` : ''} — факты из данных игры (GSI)`, lines: f.lines });
  }
  return (
    <Card title="Разбор матча">
      {list === null ? (
        <p className="muted">Загрузка записей…</p>
      ) : list.length === 0 ? (
        <p className="muted" data-testid="sessions-empty">
          Записанных матчей нет. Коуч записывает данные игры (GSI), когда Dota подключена на странице «Живая игра». Разбор видеозаписи — в конце
          «Разбора записи».
        </p>
      ) : (
        <label>
          Матч
          <select value={sel} onChange={(e) => void open(e.target.value)} data-testid="sessions-select">
            <option value="">— выберите —</option>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.day} · {s.hero ?? 'герой ?'} · {s.durationSec !== null ? mmss(s.durationSec) : '?'}
              </option>
            ))}
          </select>
        </label>
      )}
      {err && <p className="error small">{err}</p>}
      {facts && <MatchSummary label={facts.label} lines={facts.lines} />}
    </Card>
  );
}

export function AiAssistant(_props: PageProps) {
  const { settings, update, error } = useSettings();
  const ai = useAiState();
  const getFacts = usePageFacts('assistant');
  return (
    <>
      <PageHeader
        title="ИИ-помощник"
        subtitle="Отвечает на вопросы по данным коуча: матч, база знаний патча, записи. ИИ ничего не считает и не смотрит игру сам — только объясняет то, что посчитал коуч."
      />
      {error && <p className="error">{error}</p>}
      <Card title="Спроси коуча">
        <AskCoach page="assistant" getFacts={getFacts} chat placeholder="Например: сколько стоит BKB? когда руна силы?" />
      </Card>
      {settings && ai && (
        <>
          <ProviderChoice settings={settings} update={update} />
          <LocalCard ai={ai} settings={settings} update={update} />
          <CloudCard ai={ai} settings={settings} update={update} />
        </>
      )}
      <SessionsCard />
      <p className="muted small">Подсказки во время матча на основе ИИ появятся в следующих обновлениях.</p>
    </>
  );
}

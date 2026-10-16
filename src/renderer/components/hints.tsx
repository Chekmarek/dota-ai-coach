// Переключатели live-подсказок (решение владельца 2026-10-13, docs/POLICY.md) и настройки подсказок этапа 4:
// подробность, категории, ИИ во время матча, лента в окне коуча. Одни и те же — в «Настройках» и на «Живой игре»;
// сохраняются сразу в settings.hints. Вид подсказок поверх игры — на странице «Предпросмотр подсказок».
import { useEffect, useState } from 'react';
import type { HintCategories, HintDetail, Settings, SettingsPatch } from '@shared/schemas/settings';
import type { CoachStateMessage } from '@shared/ipc';

const DETAIL_RU: Record<HintDetail, string> = { min: 'Минимум — только короткая фраза', normal: 'Обычный — фраза и пояснение', detailed: 'Подробно — с фактами и факторами %' };
const CATEGORY_RU: Record<keyof HintCategories, string> = {
  danger: 'Опасность (пропавшие враги, смок, мало здоровья)',
  fight: 'Драки и решения (вступать, 1×1, фокус)',
  macro: 'Макро и цели (пуш, Рошан, помощь команде)',
  laning: 'Линия (добивания, реген, уровни)',
  economy: 'Фарм и экономика (золото, предметы, навыки)',
  timing: 'Тайминги (руны, стаки, день и ночь)',
  mistake: 'Ошибки во время игры',
  review: 'Разборы после смерти и матча',
};

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
      <p className="muted small">
        Рейтинговый матч или обычный, Dota через GSI не сообщает: если подсказки в рейтинге не нужны, выключайте «Включить live-подсказки» перед рейтинговой игрой.
      </p>
      <label>
        Подробность подсказок
        <select value={h.detail} disabled={!h.enabled} onChange={(e) => void update({ hints: { detail: e.target.value as HintDetail } })} data-testid={`${testIdPrefix}-detail`}>
          {(Object.keys(DETAIL_RU) as HintDetail[]).map((d) => (
            <option key={d} value={d}>
              {DETAIL_RU[d]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="hints-cats" disabled={!h.enabled}>
        <legend>Какие подсказки показывать</legend>
        {(Object.keys(CATEGORY_RU) as (keyof HintCategories)[]).map((c) => (
          <label key={c} className="check">
            <input type="checkbox" checked={h.categories[c]} onChange={(e) => void update({ hints: { categories: { ...h.categories, [c]: e.target.checked } } })} data-testid={`${testIdPrefix}-cat-${c}`} />
            {CATEGORY_RU[c]}
          </label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={h.ai} disabled={!h.enabled} onChange={(e) => void update({ hints: { ai: e.target.checked } })} data-testid={`${testIdPrefix}-ai`} />
        Советы и разборы ИИ во время матча (если ИИ включён на странице «ИИ-помощник»)
      </label>
      <label className="check">
        <input type="checkbox" checked={h.inApp} disabled={!h.enabled} onChange={(e) => void update({ hints: { inApp: e.target.checked } })} data-testid={`${testIdPrefix}-inapp`} />
        Дублировать подсказки в окне коуча (страница «Живая игра»)
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.hud.enabled} disabled={!h.enabled} onChange={(e) => void update({ hud: { enabled: e.target.checked } })} data-testid={`${testIdPrefix}-hud`} />
        Показывать подсказки поверх игры (вид — «Предпросмотр подсказок»)
      </label>
    </>
  );
}

/** Подсказки, которые сейчас на экране (main → интерфейс) */
export function useCoachState(): CoachStateMessage {
  const [state, setState] = useState<CoachStateMessage>({ hints: [], inMatch: false });
  useEffect(() => window.dotacoach.onCoachState(setState), []);
  return state;
}

const SEV_RU = { critical: 'Важно', advice: 'Совет', info: 'Инфо' } as const;

/** Лента подсказок в окне коуча (страница «Живая игра») */
export function HintsFeed() {
  const { hints, inMatch } = useCoachState();
  return (
    <div className="hints-feed" data-testid="hints-feed">
      <div className="row">
        <button onClick={() => void window.dotacoach.showMatchups()} disabled={!inMatch} title="Шанс 1×1 против каждого известного врага — поверх игры и здесь" data-testid="show-matchups">
          Матчапы
        </button>
        <span className="muted small">{inMatch ? 'Матч идёт' : 'Подсказки появятся во время матча'}</span>
      </div>
      {hints.length === 0 ? (
        <p className="muted small" data-testid="hints-empty">
          Сейчас подсказок нет — коуч молчит, пока нечего сказать.
        </p>
      ) : (
        <ul className="hints-list">
          {hints.map((h) => (
            <li key={h.seq} className={`hint-item hint-${h.priority}`} data-testid="hint-item">
              <b>
                {SEV_RU[h.priority]}
                {h.source === 'ai' ? ' · ИИ' : ''}:
              </b>{' '}
              {h.review ? h.review.heading : h.title}
              {h.percent && <span className="hint-pct"> · {h.percent.value}%</span>}
              {h.text && <div className="muted small">{h.text}</div>}
              {h.review && (
                <div className="small">
                  {h.review.why.join('; ')}
                  {h.review.tips.length > 0 && <div>Совет: {h.review.tips.join(' ')}</div>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

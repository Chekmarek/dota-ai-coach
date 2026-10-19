// Переключатели live-подсказок (решение владельца 2026-10-13, docs/POLICY.md) и настройки подсказок этапа 4:
// подробность, категории, ИИ во время матча, лента в окне коуча. Одни и те же — в «Настройках» и на «Живой игре»;
// сохраняются сразу в settings.hints. Вид подсказок поверх игры — на странице «Подсказки в игре».
import { useEffect, useState } from 'react';
import { BAD_ADVICE_SHORTCUT_DEFAULT, acceleratorOf, isSafeBadAdviceShortcut, type HintCategories, type HintDetail, type Settings, type SettingsPatch } from '@shared/schemas/settings';
import type { CoachStateMessage } from '@shared/ipc';
import type { GameModeOverride } from '@core/gsi/mode.ts';
import { GameModeBadge, currentGameMode } from './gsi';
import { showModeToast } from './mode-toast';
import { useGsi } from '../hooks/useGsi';
import { modeBannerText, resolveGameMode } from '@core/gsi/mode.ts';
import { POSITION_OVERRIDES, type PositionOverride } from '@core/coach/position.ts';

const POSITION_OPTION_RU: Record<PositionOverride, string> = {
  auto: 'Определять сама (по герою и линии)',
  '1': '1 — керри (лёгкая линия)',
  '2': '2 — центр',
  '3': '3 — оффлейн (сложная линия)',
  '4': '4 — частичная поддержка',
  '5': '5 — полная поддержка',
};

const MODE_RU: Record<GameModeOverride, string> ={ auto: 'Определять по данным игры', turbo: 'Турбо', normal: 'Обычный режим (All Pick, рейтинг)' };

const DETAIL_RU: Record<HintDetail, string> = { min: 'Только действие — одна фраза', normal: 'Коротко — действие и причина', detailed: 'Подробно — с фактами и факторами %' };
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
  const gsi = useGsi();
  /** Выбор режима — сразу уведомление, каким коуч теперь считает режим (с «auto» — что сообщила игра) */
  const pickMode = async (m: GameModeOverride) => {
    await update({ hints: { gameMode: m } });
    const fromGame = currentGameMode(gsi, Date.now());
    const info = resolveGameMode(fromGame.source === 'manual' ? gsi?.gameModeDetected ?? null : fromGame, m);
    showModeToast({ mode: info.mode, source: info.source, ...modeBannerText(info) });
  };
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
        Режим игры
        <select value={h.gameMode} onChange={(e) => void pickMode(e.target.value as GameModeOverride)} data-testid={`${testIdPrefix}-game-mode`}>
          {(Object.keys(MODE_RU) as GameModeOverride[]).map((m) => (
            <option key={m} value={m}>
              {MODE_RU[m]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        Сейчас: <GameModeBadge testId={`${testIdPrefix}-game-mode-now`} />. Если Dota не сообщает режим, выберите его здесь вручную. Без данных
        игры и без выбора коуч считает игру обычной.
      </p>
      <label>
        Моя позиция
        <select value={h.position} onChange={(e) => void update({ hints: { position: e.target.value as PositionOverride } })} data-testid={`${testIdPrefix}-position`}>
          {POSITION_OVERRIDES.map((p) => (
            <option key={p} value={p}>
              {POSITION_OPTION_RU[p]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        От позиции зависят советы: керри в лайнинге не зовут в лес и на чужие драки, саппорту напоминают про варды и стаки. «Определять
        сама» — по герою и линии в первые минуты; если коуч не уверен, он попросит выбрать позицию здесь.
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
      <BadAdviceShortcutField value={h.badAdviceShortcut} update={update} testId={`${testIdPrefix}-bad-advice-shortcut`} />
      <label className="check">
        <input type="checkbox" checked={settings.hud.enabled} disabled={!h.enabled} onChange={(e) => void update({ hud: { enabled: e.target.checked } })} data-testid={`${testIdPrefix}-hud`} />
        Показывать подсказки поверх игры (вид — раздел «Подсказки в игре»)
      </label>
    </>
  );
}

/**
 * Клавиша «плохой совет»: фокус на поле и нажать сочетание. Принимаются только безопасные (isSafeBadAdviceShortcut):
 * клавиша глобальная — пока коуч запущен, это сочетание не дойдёт ни до Доты, ни до других программ.
 */
function BadAdviceShortcutField({ value, update, testId }: { value: string; update: (p: SettingsPatch) => Promise<void>; testId: string }) {
  const [hint, setHint] = useState<string | null>(null);
  return (
    <>
      <label>
        Клавиша «плохой совет»
        <input
          readOnly
          value={value || 'выключена'}
          data-testid={testId}
          onKeyDown={(e) => {
            if (e.key === 'Tab') return;
            e.preventDefault();
            const acc = acceleratorOf(e);
            if (!acc) return setHint('Нажмите сочетание: Ctrl/Alt + F1…F12, или два модификатора + буква/цифра.');
            if (!isSafeBadAdviceShortcut(acc)) return setHint(`${acc} не подходит: нужен Ctrl или Alt, а с буквой или цифрой — два модификатора.`);
            setHint(null);
            void update({ hints: { badAdviceShortcut: acc } });
          }}
        />
      </label>
      <p className="muted small">
        Подсказка не к месту — нажмите в игре: коуч сохранит подсказки на экране и последние 15 с матча (видны в «Истории советов»). Чтобы
        сменить — щёлкните по полю и нажмите сочетание.{' '}
        <button className="link" onClick={() => void update({ hints: { badAdviceShortcut: BAD_ADVICE_SHORTCUT_DEFAULT } })}>
          По умолчанию ({BAD_ADVICE_SHORTCUT_DEFAULT})
        </button>{' '}
        <button className="link" onClick={() => void update({ hints: { badAdviceShortcut: '' } })} data-testid={`${testId}-off`}>
          Выключить
        </button>
      </p>
      {hint && <p className="warn small">{hint}</p>}
    </>
  );
}

/** Подсказки, которые сейчас на экране (main → интерфейс) */
export function useCoachState(): CoachStateMessage {
  const [state, setState] = useState<CoachStateMessage>({ hints: [], inMatch: false, mode: null });
  useEffect(() => window.dotacoach.onCoachState(setState), []);
  return state;
}

const SEV_RU = { critical: 'Срочно', advice: 'Совет', info: 'Инфо' } as const;

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
              <div className="hint-head">
                <span className={`hint-sev sev-${h.priority}`}>{SEV_RU[h.priority]}</span>
                {h.source === 'ai' && <span className="hint-src">ИИ</span>}
                <b className="hint-title">{h.review ? h.review.heading : h.title}</b>
                {h.percent && <span className="hint-pct">{h.percent.value}%</span>}
              </div>
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

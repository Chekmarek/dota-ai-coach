// Распознавание HUD (бывшая страница «Диагностика зрения»). В обновлении 0.5.0 команда убрала отдельную вкладку —
// содержимое перенесено в «Живую игру» (вместо заглушки этапа C) и в «Разбор записи».
import type { Validity } from '@shared/types/observation';
import { HUD_FIELDS, formatClock, type HudFieldId, type Pool } from '@core/vision/hud-fields.ts';
import type { HudReading } from '@core/vision/recognize-hud.ts';
import layoutJson from '../../data/hud-layouts/dota2-default-16x9.json';
import { useAge, useEngine } from '../hooks/useEngine';
import { Card, NotImplemented } from './ui';

const LABELS = Object.fromEntries(Object.entries(layoutJson.regions).map(([k, v]) => [k, v.label])) as Record<HudFieldId, string>;

export const VALIDITY_LABEL: Record<Validity, string> = {
  valid: 'распознано',
  stale: 'устарело',
  conflicting: 'противоречие',
  'out-of-range': 'неправдоподобно',
  unparsed: 'не уверен',
  absent: 'нет на экране',
  unsupported: 'интерфейс не поддерживается',
};

export function formatHudValue(id: HudFieldId, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (id === 'gameClock') return formatClock(v as number);
  if (id === 'health' || id === 'mana') {
    const p = v as Pool;
    return `${p.current} / ${p.max}`;
  }
  return String(v);
}

const NOT_YET = [
  'Способности и их перезарядка',
  'Инвентарь',
  'Индикаторы карты',
  'Видимые противники',
  'Открытые меню (магазин, таблица)',
];

/** Рамки областей HUD поверх превью: зелёная — значение принято, красная — отброшено */
export function RegionOverlay({ reading }: { reading: HudReading }) {
  return (
    <svg className="overlay" viewBox={`0 0 ${reading.frameSize.w} ${reading.frameSize.h}`} preserveAspectRatio="xMidYMid meet" data-testid="hud-regions">
      {HUD_FIELDS.map((id) => {
        const o = reading.fields[id];
        const r = o.sourceRegion.rect;
        return <rect key={id} x={r.x} y={r.y} width={r.w} height={r.h} className={`roi roi-${o.value !== null ? 'ok' : 'bad'}`} />;
      })}
    </svg>
  );
}

/** Карточки распознавания: производительность, чья панель, герой, таблица значений */
export function HudRecognition() {
  const { status, vision, visionAt } = useEngine();
  const reading = vision?.reading;
  const age = useAge(visionAt);

  return (
    <>
      <div className="grid-2">
        <Card title="Распознавание HUD">
          <div className="stats stats-col">
            <div className="stat">
              <div className="stat-label">Распознавание кадра</div>
              <div className="stat-value" data-testid="vision-ms">{status?.pipeline.visionMs != null ? `${status.pipeline.visionMs} мс` : '—'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Обработка</div>
              <div className="stat-value">{status?.processingFps ?? 0} к/с</div>
            </div>
          </div>
          {reading && !reading.supported && (
            <p className="warn">Соотношение сторон кадра не 16:9 — раскладка HUD не подходит, распознавание отключено.</p>
          )}
          {age !== null && age > 3 && status?.state === 'running' && <p className="warn">Данные устарели: обновлений нет {age.toFixed(0)} с</p>}
        </Card>
        <Card title="Чья панель внизу">
          {reading ? (
            <>
              <div className="stat" data-testid="selected-unit">
                <div className="stat-label">Нижняя панель показывает</div>
                <div className="stat-value">
                  {reading.selectedUnit.value === 'enemy' ? (
                    <span className="error">вражеского юнита</span>
                  ) : reading.selectedUnit.value === 'ally' ? (
                    'своего героя или союзника'
                  ) : (
                    <span className="muted">не определено</span>
                  )}
                </div>
              </div>
              <div className="stat" data-testid="hero-name">
                <div className="stat-label">Герой на панели (уверенность {reading.heroName.confidence.toFixed(2)})</div>
                <div className="stat-value">{reading.heroName.value ? reading.heroName.value.name : <span className="muted">не распознан</span>}</div>
                {reading.heroNameCandidates.length > 0 && (
                  <div className="muted small">кандидаты: {reading.heroNameCandidates.map((c) => `${c.name} (${c.cost})`).join(', ')}</div>
                )}
              </div>
              {reading.selectedUnit.value === 'enemy' && (
                <p className="warn">Выбран враг: здоровье, мана, уровень и золото на панели — не ваши. Коуч не будет использовать их как данные игрока.</p>
              )}
            </>
          ) : (
            <span className="muted">Нет данных</span>
          )}
        </Card>
      </div>

      <Card title="Распознанные значения">
        {reading ? (
          <table className="table" data-testid="vision-table">
            <thead>
              <tr>
                <th>Элемент</th>
                <th>Значение</th>
                <th>Прочитанный текст</th>
                <th>Уверенность</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {HUD_FIELDS.map((id) => {
                const o = reading.fields[id];
                return (
                  <tr key={id} data-testid={`vision-row-${id}`}>
                    <td>{LABELS[id]}</td>
                    <td className="mono strong" data-testid={`vision-value-${id}`}>{formatHudValue(id, o.value)}</td>
                    <td className="mono muted">{o.raw || '—'}</td>
                    <td>
                      <div className="conf" title={o.confidence.toFixed(2)}>
                        <div className={`conf-bar ${o.confidence >= 0.8 ? 'hi' : o.confidence >= 0.5 ? 'mid' : 'lo'}`} style={{ width: `${Math.round(o.confidence * 100)}%` }} />
                      </div>
                    </td>
                    <td className={o.value !== null ? 'ok-text' : 'warn'}>{VALIDITY_LABEL[o.validity]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <span className="muted">Пока нет данных — запустите живой захват или запись.</span>
        )}
      </Card>

      <NotImplemented stage="этап C, продолжение">
        Ещё не распознаются: {NOT_YET.join(', ')}. Для этих элементов нужны шаблоны иконок — будут добавлены следующим шагом.
      </NotImplemented>
    </>
  );
}

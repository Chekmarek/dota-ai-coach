import { useMemo, useState } from 'react';
import { AskCoach } from '../components/ask';
import { usePageFacts } from '../hooks/useFacts';
import type { KbHero, KbItem, KbItemAvailability, KnowledgeBase as Kb } from '@shared/types/kb';
import { formatKbGain, formatKbList, formatKbNumber as fmt } from '@core/knowledge-base/format.ts';
import { isShopItem } from '@core/knowledge-base/audit.ts';
import { Card, PageHeader } from '../components/ui';
import { MechanicsTab } from '../components/mechanics';
import { useKnowledgeBase } from '../hooks/useKnowledgeBase';

const AVAILABILITY_LABEL: Record<KbItemAvailability, string> = {
  shop: 'магазин',
  neutral: 'нейтральный',
  'not-sold': 'не продаётся',
  removed: 'нет в игре',
};

const ATTR_LABEL = { str: 'Сила', agi: 'Ловкость', int: 'Интеллект', all: 'Универсальный' } as const;

export function KnowledgeBase() {
  const { kb, error } = useKnowledgeBase();
  const [tab, setTab] = useState<'heroes' | 'items' | 'mechanics'>('heroes');
  const getFacts = usePageFacts('kb', undefined, false);
  const [query, setQuery] = useState('');
  const [heroKey, setHeroKey] = useState<string | null>(null);
  const [showAllItems, setShowAllItems] = useState(false);

  const q = query.trim().toLowerCase();
  const heroes = useMemo(() => (kb?.heroes ?? []).filter((h) => !q || h.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)), [kb, q]);
  // По умолчанию — предметы, которые есть в игре (магазин и нейтральные); остальные — по переключателю
  const visibleItems = useMemo(() => (kb?.items ?? []).filter((i) => showAllItems || isInGame(i)), [kb, showAllItems]);
  const hiddenCount = (kb?.items.length ?? 0) - (kb?.items ?? []).filter(isInGame).length;
  const items = useMemo(() => visibleItems.filter((i) => !q || i.name.toLowerCase().includes(q)), [visibleItems, q]);
  const hero = kb?.heroes.find((h) => h.key === heroKey) ?? heroes[0] ?? null;

  return (
    <>
      <PageHeader title="База знаний" subtitle="Герои, способности, предметы и механика карты текущего патча — с источником и датой." />
      <Card title="Спросить коуча о базе знаний">
        <AskCoach page="kb" getFacts={getFacts} compact placeholder="Например: сколько стоит манта? перезарядка Meat Hook?" />
      </Card>
      {error && <p className="error">{error}</p>}
      {kb && (
        <>
          <div className="not-impl" role="note" data-testid="kb-unverified">
            <span className="not-impl-badge">Не проверено вручную · патч {kb.meta.patch} от {kb.meta.patchDate}</span>
            <p>
              Импортировано автоматически {new Date(kb.meta.generatedAt).toLocaleDateString('ru-RU')} из:{' '}
              {kb.meta.sources
                .filter((s) => !s.covers.includes('mechanics'))
                .map((s) => s.name + (s.license ? ` (${s.license})` : ''))
                .join(', ')}. Точные расчёты не будут
              использовать эти данные, пока они не сверены с патч-ноутами.
              {kb.audit.costMismatches.length > 0 &&
                ` Самопроверка нашла расхождений в ценах: ${kb.audit.costMismatches.length} (${kb.audit.costMismatches.map((m) => m.name).join(', ')}).`}
            </p>
            <p className="muted small" data-testid="kb-copy" data-copy={kb.copy}>
              Копия базы: {kb.copy === 'asar' ? 'из обновления приложения (app.asar)' : 'рядом с программой (resources\data)'}
            </p>
          </div>

          <div className="row gap">
            <button className={tab === 'heroes' ? 'primary' : ''} onClick={() => setTab('heroes')} data-testid="kb-tab-heroes">
              Герои ({kb.meta.counts.heroes})
            </button>
            <button className={tab === 'items' ? 'primary' : ''} onClick={() => setTab('items')} data-testid="kb-tab-items">
              Предметы ({visibleItems.length})
            </button>
            <button className={tab === 'mechanics' ? 'primary' : ''} onClick={() => setTab('mechanics')} data-testid="kb-tab-mechanics">
              Механика ({kb.mechanics.length})
            </button>
            {tab !== 'mechanics' && (
              <input placeholder="Поиск по названию…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="kb-search" style={{ minWidth: 240 }} />
            )}
          </div>

          {tab === 'mechanics' ? (
            <MechanicsTab entries={kb.mechanics} warnings={kb.mechanicsWarnings} />
          ) : tab === 'heroes' ? (
            <div className="kb-split">
              <Card title={`Герои: ${heroes.length}`}>
                <div className="kb-list">
                  {heroes.map((h) => (
                    <button key={h.key} className={`kb-row${hero?.key === h.key ? ' active' : ''}`} onClick={() => setHeroKey(h.key)}>
                      <span>{h.name}</span>
                      <span className={`attr attr-${h.primaryAttr}`}>{h.primaryAttr ? ATTR_LABEL[h.primaryAttr] : '—'}</span>
                    </button>
                  ))}
                </div>
              </Card>
              {hero && <HeroCard hero={hero} />}
            </div>
          ) : (
            <>
              <label className="row gap small">
                <input type="checkbox" checked={showAllItems} onChange={(e) => setShowAllItems(e.target.checked)} data-testid="kb-show-all-items" />
                Показать предметы не из игры и не из магазина ({hiddenCount})
              </label>
              <ItemsTable items={items} kb={kb} />
            </>
          )}
        </>
      )}
    </>
  );
}

function HeroCard({ hero }: { hero: KbHero }) {
  const s = hero.stats;
  return (
    <Card title={hero.name}>
      <div className="muted" data-testid="kb-hero-name">
        {hero.primaryAttr ? ATTR_LABEL[hero.primaryAttr] : '—'} · {hero.attackType === 'melee' ? 'ближний бой' : 'дальний бой'} · роли:{' '}
        {hero.roles.join(', ') || '—'}
      </div>
      <div className="stats">
        <StatMini label="Сила" value={`${fmt(s.str.base)} ${formatKbGain(s.str.gain)}`} />
        <StatMini label="Ловкость" value={`${fmt(s.agi.base)} ${formatKbGain(s.agi.gain)}`} />
        <StatMini label="Интеллект" value={`${fmt(s.int.base)} ${formatKbGain(s.int.gain)}`} />
        <StatMini label="Здоровье (1 ур.)" value={fmt(s.maxHealth)} />
        <StatMini label="Мана (1 ур.)" value={fmt(s.maxMana)} />
        <StatMini label="Броня" value={fmt(s.armor)} testId="kb-hero-armor" />
        <StatMini label="Урон" value={`${fmt(s.damageMin)}–${fmt(s.damageMax)}`} />
        <StatMini label="Скорость" value={fmt(s.moveSpeed)} />
        <StatMini label="Дальность атаки" value={fmt(s.attackRange)} />
        <StatMini label="Интервал атаки, с" value={fmt(s.attackRate)} />
        <StatMini label="Реген. здоровья" value={fmt(s.healthRegen)} />
        <StatMini label="Реген. маны" value={fmt(s.manaRegen)} />
      </div>
      <h4 className="kb-h">Способности</h4>
      <div className="kb-abilities">
        {hero.abilities.map((a) => (
          <div key={a.id} className="kb-ability">
            <div className="row">
              <b>{a.name}</b>
              {a.innate && <span className="pill">врождённая</span>}
              {a.scepter && <span className="pill">Aghanim's Scepter</span>}
              {a.shard && <span className="pill">Shard</span>}
            </div>
            {(a.cooldowns.length > 0 || a.manaCosts.length > 0) && (
              <div className="muted small mono">
                {a.cooldowns.length > 0 && `перезарядка ${formatKbList(a.cooldowns)} с`}
                {a.cooldowns.length > 0 && a.manaCosts.length > 0 && ' · '}
                {a.manaCosts.length > 0 && `мана ${formatKbList(a.manaCosts)}`}
              </div>
            )}
            {a.descRu && <p className="kb-desc">{a.descRu}</p>}
          </div>
        ))}
      </div>
      {hero.talents.length > 0 && (
        <>
          <h4 className="kb-h">Таланты</h4>
          <ul className="kb-talents">
            {hero.talents.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function ItemsTable({ items, kb }: { items: KbItem[]; kb: Kb }) {
  const names = new Map(kb.items.map((i) => [i.key, i.name]));
  const mismatch = new Map(kb.audit.costMismatches.map((m) => [m.key, m]));
  return (
    <Card title={`Предметы: ${items.length}`}>
      <table className="table" data-testid="kb-items">
        <thead>
          <tr>
            <th>Предмет</th>
            <th>Цена</th>
            <th>Из чего собирается</th>
            <th>Где взять</th>
            <th>Проверка</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const m = mismatch.get(i.key);
            return (
              <tr key={i.key}>
                <td>{i.name}</td>
                <td className="mono" title={i.priceSource === 'valve' ? 'цена: Valve datafeed' : i.priceSource ? 'цена: OpenDota' : undefined}>
                  {i.cost ?? '—'}
                </td>
                <td className="small">
                  {i.components.map((c) => names.get(c) ?? c).join(' + ')}
                  {i.recipeCost && isShopItem(i) ? `${i.components.length ? ' + ' : ''}рецепт ${i.recipeCost}` : ''}
                </td>
                <td className="small" data-availability={i.availability ?? 'shop'}>
                  {AVAILABILITY_LABEL[i.availability ?? 'shop']}
                  {i.neutralTier ? `, уровень ${i.neutralTier}` : ''}
                </td>
                <td className={m ? 'warn small' : 'muted small'} title={m?.reason ?? undefined}>
                  {m ? `сумма частей ${m.computed} ≠ ${m.cost}${m.reason ? ' (расхождение в данных Valve)' : ''}` : i.components.length && isShopItem(i) ? 'сходится' : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/** Есть в игре: продаётся/собирается или нейтральный предмет текущего набора */
const isInGame = (i: KbItem) => isShopItem(i) || i.availability === 'neutral';

function StatMini({ label, value, testId }: { label: string; value: string | number; testId?: string }) {
  return (
    <div className="stat" data-testid={testId}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

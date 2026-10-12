import { useEffect, useMemo, useState } from 'react';
import type { KbHero, KbItem, KnowledgeBase as Kb } from '@shared/types/kb';
import { Card, PageHeader } from '../components/ui';

let cache: Kb | null = null;

const ATTR_LABEL = { str: 'Сила', agi: 'Ловкость', int: 'Интеллект', all: 'Универсальный' } as const;

export function KnowledgeBase() {
  const [kb, setKb] = useState<Kb | null>(cache);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'heroes' | 'items'>('heroes');
  const [query, setQuery] = useState('');
  const [heroKey, setHeroKey] = useState<string | null>(null);

  useEffect(() => {
    if (cache) return;
    void window.dotacoach.getKnowledgeBase().then((r) => {
      if ('error' in r) setError(r.error);
      else {
        cache = r;
        setKb(r);
      }
    });
  }, []);

  const q = query.trim().toLowerCase();
  const heroes = useMemo(() => (kb?.heroes ?? []).filter((h) => !q || h.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)), [kb, q]);
  const items = useMemo(() => (kb?.items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q)), [kb, q]);
  const hero = kb?.heroes.find((h) => h.key === heroKey) ?? heroes[0] ?? null;

  return (
    <>
      <PageHeader title="База знаний" subtitle="Герои, способности и предметы текущего патча — с источником и датой." />
      {error && <p className="error">{error}</p>}
      {kb && (
        <>
          <div className="not-impl" role="note" data-testid="kb-unverified">
            <span className="not-impl-badge">Не проверено вручную · патч {kb.meta.patch} от {kb.meta.patchDate}</span>
            <p>
              Импортировано автоматически {new Date(kb.meta.generatedAt).toLocaleDateString('ru-RU')} из:{' '}
              {kb.meta.sources.map((s) => s.name + (s.license ? ` (${s.license})` : '')).join(', ')}. Точные расчёты не будут
              использовать эти данные, пока они не сверены с патч-ноутами.
              {kb.audit.costMismatches.length > 0 && ` Самопроверка нашла расхождений в ценах: ${kb.audit.costMismatches.length}.`}
            </p>
          </div>

          <div className="row gap">
            <button className={tab === 'heroes' ? 'primary' : ''} onClick={() => setTab('heroes')} data-testid="kb-tab-heroes">
              Герои ({kb.meta.counts.heroes})
            </button>
            <button className={tab === 'items' ? 'primary' : ''} onClick={() => setTab('items')} data-testid="kb-tab-items">
              Предметы ({kb.meta.counts.items})
            </button>
            <input placeholder="Поиск по названию…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="kb-search" style={{ minWidth: 240 }} />
          </div>

          {tab === 'heroes' ? (
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
            <ItemsTable items={items} kb={kb} />
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
        <StatMini label="Сила" value={`${s.str.base} +${s.str.gain}`} />
        <StatMini label="Ловкость" value={`${s.agi.base} +${s.agi.gain}`} />
        <StatMini label="Интеллект" value={`${s.int.base} +${s.int.gain}`} />
        <StatMini label="Здоровье (1 ур.)" value={s.maxHealth} />
        <StatMini label="Мана (1 ур.)" value={s.maxMana} />
        <StatMini label="Броня" value={s.armor} />
        <StatMini label="Урон" value={`${s.damageMin}–${s.damageMax}`} />
        <StatMini label="Скорость" value={s.moveSpeed} />
        <StatMini label="Дальность атаки" value={s.attackRange} />
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
                {a.cooldowns.length > 0 && `перезарядка ${a.cooldowns.join('/')} с`}
                {a.cooldowns.length > 0 && a.manaCosts.length > 0 && ' · '}
                {a.manaCosts.length > 0 && `мана ${a.manaCosts.join('/')}`}
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
            <th>Проверка</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const m = mismatch.get(i.key);
            return (
              <tr key={i.key}>
                <td>{i.name}</td>
                <td className="mono">{i.cost ?? '—'}</td>
                <td className="small">
                  {i.components.map((c) => names.get(c) ?? c).join(' + ')}
                  {i.recipeCost ? `${i.components.length ? ' + ' : ''}рецепт ${i.recipeCost}` : ''}
                </td>
                <td className={m ? 'warn small' : 'muted small'}>{m ? `сумма частей ${m.computed} ≠ ${m.cost}` : i.components.length ? 'сходится' : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function StatMini({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

// Признаки моделей не должны быть константой (DECISIONS.md п. 67): здоровье союзников — с зелёных полосок на экране,
// стадия по предметам — из предметов GSI. Проверка через стенд экзамена (exam-lib.ts: тело GSI → readGsi →
// MatchStateModel → снимок коуча) — тот же путь, что в живой игре.
import { describe, expect, it } from 'vitest';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { FIGHT_FEATURES, fightFeatures } from '../../src/core/coach/fight-model.ts';
import { DANGER_FEATURES, dangerFeatures, itemValueOf } from '../../src/core/coach/danger-model.ts';
import { GamePipeline, type XMatch, type XPlayer } from './exam-lib.ts';
import { realData } from './coach-sim.ts';

const data = realData();
const look = new CoachLookup(data);
const itemKey = new Map(data.items.map((i) => [i.id, i.key]));
const idOf = (key: string) => data.items.find((i) => i.key === key)!.id;
const NO_NOISE = { minimapMissEnemy: 0, minimapMissAlly: 0, minimapJitter: 0, barMissEnemy: 0, barMissOwn: 0, levelUnread: 0, hpJitter: 0 };

/** Матч из 10 героев, стоящих на месте: мы (0) и союзник (1) рядом в центре, враг (5) рядом, остальные далеко */
function match(opts: { inventory: boolean; allyHp: number }): XMatch {
  const heroIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const cell = (w: number) => Math.round((w + 16240) / 128);
  const near = new Map<number, [number, number]>([[0, [0, 0]], [1, [300, 0]], [5, [600, 200]]]);
  const players: XPlayer[] = heroIds.map((heroId, i) => {
    const [x, y] = near.get(i) ?? (i < 5 ? [-6000, -6000] : [6000, 6000]);
    const hp = i === 1 ? opts.allyHp : 100;
    return {
      heroId,
      isRadiant: i < 5,
      position: null,
      playbackData: {
        playerUpdatePositionEvents: [{ time: -100, x: cell(x), y: cell(y) }],
        playerUpdateHealthEvents: [{ time: -100, hp: hp * 10, maxHp: 1000, mp: 300, maxMp: 300 }],
        playerUpdateLevelEvents: [{ time: -100, level: 10 + i }],
        playerUpdateGoldEvents: [{ time: -100, gold: 500, networth: 9000 }],
        purchaseEvents: [],
        deathEvents: [],
        killEvents: [],
      },
    };
  });
  players[0]!.playbackData.inventoryEvents = opts.inventory ? [{ time: -100, item0: { itemId: idOf('blink'), charges: null }, item1: { itemId: idOf('black_king_bar'), charges: null } } as never] : [];
  return { id: 1, durationSeconds: 1800, players };
}

function viewAt(m: XMatch, t = 600) {
  const pipe = new GamePipeline(m, 0, false, itemKey, 7, NO_NOISE);
  let input = pipe.tick(pipe.startClock);
  for (let s = pipe.startClock + 1; s <= t; s += 1) input = pipe.tick(s);
  return buildView(input.state, input.gsi, input.gsiWallMs);
}
const itemValue = (v: ReturnType<typeof viewAt>) => (v.me.itemsKnown ? itemValueOf(v.me.items.map((i) => i.key), (k) => look.itemCost(k)) : null);
const fi = (k: (typeof FIGHT_FEATURES)[number]) => FIGHT_FEATURES.indexOf(k);

describe('признаки моделей — не константа', () => {
  it('цена предмета — с префиксом GSI и без', () => {
    expect(look.itemCost('blink')).toBeGreaterThan(0);
    expect(look.itemCost('item_blink')).toBe(look.itemCost('blink'));
  });

  it('здоровье союзника рядом — с зелёной полоски на экране, и оно меняет признак', () => {
    const hurt = viewAt(match({ inventory: true, allyHp: 30 }));
    const full = viewAt(match({ inventory: true, allyHp: 90 }));
    expect(hurt.screen.allyBars.length).toBe(1);
    const a = fightFeatures(hurt, { itemValue: itemValue(hurt), turbo: false, risk: 0 })!;
    const b = fightFeatures(full, { itemValue: itemValue(full), turbo: false, risk: 0 })!;
    expect(a[fi('allyHpKnown')]).toBe(1);
    expect(a[fi('allyHp')]).toBeCloseTo(0.3, 1);
    expect(b[fi('allyHp')]).toBeCloseTo(0.9, 1);
  });

  it('стадия по предметам: предметы GSI доходят и дают цену; без инвентаря — «неизвестно», а не «предметов нет»', () => {
    const withInv = viewAt(match({ inventory: true, allyHp: 90 }));
    expect(withInv.me.itemsKnown).toBe(true);
    expect(withInv.me.items.map((i) => i.key).sort()).toEqual(['black_king_bar', 'blink']);
    const iv = itemValue(withInv)!;
    expect(iv).toBeGreaterThan(5000);
    const noInv = viewAt(match({ inventory: false, allyHp: 90 }));
    expect(noInv.me.itemsKnown).toBe(false);
    const f1 = fightFeatures(withInv, { itemValue: iv, turbo: false, risk: 0 })!;
    const f0 = fightFeatures(noInv, { itemValue: itemValue(noInv), turbo: false, risk: 0 })!;
    expect(f1[fi('itemStage')]).toBeGreaterThan(0.3);
    expect(f0[fi('itemStage')]).toBe(0.3);
    const d = dangerFeatures(withInv, { itemValue: iv, turbo: false, history: [] })!;
    expect(d[DANGER_FEATURES.indexOf('itemStage')]).toBeGreaterThan(0);
  });
});

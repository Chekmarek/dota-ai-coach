import { describe, expect, it } from 'vitest';
import { auditItems } from '../../src/core/knowledge-base/audit.ts';
import type { KbItem } from '../../src/shared/types/kb.ts';

const item = (key: string, cost: number, components: string[] = [], recipeCost: number | null = null): KbItem => ({
  id: 1, key, name: key, cost, components, recipeCost, quality: null, neutralTier: null, cooldown: null, manaCost: null, attributes: [], abilities: [],
});

describe('самопроверка базы предметов', () => {
  it('сходящийся рецепт не помечается', () => {
    const a = auditItems([item('hammer', 1600), item('axe', 1000), item('bkb', 4050, ['hammer', 'axe'], 1450)]);
    expect(a.costMismatches).toEqual([]);
  });
  it('расхождение цены показывается, а не исправляется молча', () => {
    const a = auditItems([item('stick', 200), item('branches', 50), item('wand', 460, ['stick', 'branches', 'branches'], 150)]);
    expect(a.costMismatches).toEqual([{ key: 'wand', name: 'wand', cost: 460, computed: 450 }]);
  });
  it('предметы не из магазина (нет в игре, нейтральные) не проверяются', () => {
    const talon = { ...item('iron_talon', 0, ['qb', 'rop'], 125), availability: 'removed' as const };
    const medal = { ...item('medallion', 0, ['qb'], null), availability: 'neutral' as const };
    const a = auditItems([item('qb', 100), item('rop', 175), talon, medal]);
    expect(a.costMismatches).toEqual([]);
    expect(a.unknownComponents).toEqual([]);
  });
  it('у расхождения из данных Valve есть причина', () => {
    const shroud = { ...item('shroud', 3900, ['cloak'], 900), priceNote: 'в данных Valve' };
    const a = auditItems([item('cloak', 900), shroud]);
    expect(a.costMismatches).toEqual([{ key: 'shroud', name: 'shroud', cost: 3900, computed: 1800, reason: 'в данных Valve' }]);
  });
  it('неизвестный компонент отмечается', () => {
    const a = auditItems([item('x', 100, ['nope'])]);
    expect(a.unknownComponents).toEqual([{ key: 'x', component: 'nope' }]);
  });
});
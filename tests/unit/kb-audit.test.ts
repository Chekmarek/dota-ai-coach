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
  it('неизвестный компонент отмечается', () => {
    const a = auditItems([item('x', 100, ['nope'])]);
    expect(a.unknownComponents).toEqual([{ key: 'x', component: 'nope' }]);
  });
});
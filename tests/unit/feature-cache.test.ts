import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { FeatureCache, featureVersion } from './feature-cache.ts';

describe('кэш признаков', () => {
  it('версия меняется с набором признаков и файлами моделей', () => {
    const a = featureVersion(['hp', 'level']);
    expect(featureVersion(['hp', 'level'])).toBe(a);
    expect(featureVersion(['hp', 'level', 'mana'])).not.toBe(a);
    expect(featureVersion(['hp', 'level'], ['src/data/danger-model.json'])).not.toBe(a);
  });
  it('второй раз читает из кэша', () => {
    const c = new FeatureCache('test', `t${process.pid}`);
    let n = 0;
    expect(c.get('k', () => (n++, [[1, [0.5, 2]]]))).toEqual([[1, [0.5, 2]]]);
    expect(c.get('k', () => (n++, []))).toEqual([[1, [0.5, 2]]]);
    expect(n).toBe(1);
    expect(c.hits).toBe(1);
    rmSync(c.dir, { recursive: true, force: true });
  });
});

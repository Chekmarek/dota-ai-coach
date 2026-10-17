// Проверка ответа ИИ о драфте: выдуманные числа и герои (латиница и русские прозвища), лучший — первым, длина, обещания.
import { describe, expect, it } from 'vitest';
import { checkDraftAnswer, heroMentions } from '../../src/core/ai/draft-check';
import { realData } from './coach-sim';

const heroes = realData().heroes.map((h) => ({ key: h.key, name: h.name }));
const facts = [
  'Источник: статистика публичных матчей OpenDota, патч 7.41f. Проценты — оценка изменения шанса победы, не гарантия.',
  'Враги: Bristleback, Riki.',
  'Кандидат 1: Viper, итог +4,3%: против Bristleback +4,9% (13 200 игр); против Riki −1,4% (8 004 игры).',
  'Кандидат 2: Slardar, итог +2,8%: против Bristleback +2,1% (8 803 игры).',
];
const base = { facts, heroes, allowedHeroes: ['bristleback', 'riki', 'viper', 'slardar'], topHero: 'viper' };

describe('проверка ответа о драфте', () => {
  it('правильный ответ проходит', () => {
    const c = checkDraftAnswer({ ...base, answer: 'Возьмите Viper: против Bristleback +4,9% (13 200 игр). Запасной вариант — Slardar.' });
    expect(c).toMatchObject({ ok: true, firstHero: 'viper', inventedNumbers: [], inventedHeroes: [] });
  });

  it('выдуманное число — не проходит', () => {
    const c = checkDraftAnswer({ ...base, answer: 'Возьмите Viper: против Bristleback +7% к победе.' });
    expect(c.ok).toBe(false);
    expect(c.inventedNumbers).toEqual(['7']);
  });

  it('герой не из фактов — латиницей и по-русски', () => {
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper, или Axe.' }).inventedHeroes).toEqual(['axe']);
    // склонения русских прозвищ: «Пуджа», «инвокера»
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper, а лучше Пуджа.' }).inventedHeroes).toEqual(['pudge']);
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper или инвокера.' }).inventedHeroes).toEqual(['invoker']);
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper или инвокер.' }).inventedHeroes).toEqual(['invoker']);
    // разрешённые герои по-русски — не выдумка
    expect(checkDraftAnswer({ ...base, answer: 'Берите вайпера против бристлбека.' }).inventedHeroes).toEqual([]);
  });

  it('прозвища только целыми словами: «ам» в «амулете» — не Anti-Mage', () => {
    expect(heroMentions('купите амулет', heroes)).toEqual([]);
    expect(heroMentions('берите ам', heroes).map((m) => m.key)).toEqual(['antimage']);
  });

  it('Monkey King Bar — предмет, а не герой Monkey King', () => {
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper, потом Monkey King Bar.' }).inventedHeroes).toEqual([]);
  });

  it('первым назван не лучший — не проходит', () => {
    const c = checkDraftAnswer({ ...base, answer: 'Slardar неплох, но лучше Viper.' });
    expect(c.topFirst).toBe(false);
    expect(c.ok).toBe(false);
  });

  it('обещание победы и слишком длинный ответ — не проходят', () => {
    expect(checkDraftAnswer({ ...base, answer: 'Viper гарантированно выиграет.' }).promises).toBe(true);
    expect(checkDraftAnswer({ ...base, answer: `Viper ${'очень '.repeat(60)}хорош.` }).tooLong).toBe(true);
  });
});

describe('число — при своём герое и со своим знаком', () => {
  it('процент и игры при своём герое — да; при чужом или с чужим знаком — нет', () => {
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper: против Bristleback +4,9% (13 200 игр).' }).misattributed).toEqual([]);
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper, против Riki +4,9%.' }).misattributed).toEqual([]); // Viper в предложении — пара Viper/4,9 есть
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper. Slardar даёт +4,9%.' }).misattributed).toEqual(['+4,9%']);
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper: против Riki +1,4%.' }).misattributed).toEqual(['+1,4%']);
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper. Slardar сыграно 13 200 игр.' }).misattributed).toEqual(['13 200 игр']);
  });

  it('«слабее» при положительном вкладе — ошибка (Legion Commander +0,9% — не «слабее»)', () => {
    const f = ['Кандидат 1: Slark, итог +5,6%: против Bristleback +5,7% (18 702 игры).', 'Кандидат 2: Legion Commander, итог +4,3%: против Bristleback +3,3% (22 847 игр); сила в патче +0,9%.'];
    const b2 = { facts: f, heroes, allowedHeroes: ['slark', 'legion_commander', 'bristleback'], topHero: 'slark' };
    expect(checkDraftAnswer({ ...b2, answer: 'Возьмите Slark. Legion Commander слабее в патче на 0,9%.' }).misattributed).toEqual(['0,9%']);
    expect(checkDraftAnswer({ ...b2, answer: 'Возьмите Slark. Legion Commander сильнее в патче на 0,9%.' }).misattributed).toEqual([]);
  });
});

describe('формат уведомления', () => {
  it('повтор вопроса и списки — не годятся', () => {
    expect(checkDraftAnswer({ ...base, answer: 'Кого сейчас взять?\nViper +4,3%.' }).badFormat).toBe(true);
    expect(checkDraftAnswer({ ...base, answer: 'Варианты:\n- Viper +4,3%\n- Slardar +2,8%' }).badFormat).toBe(true);
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите **Viper**.' }).badFormat).toBe(true);
    expect(checkDraftAnswer({ ...base, answer: 'Возьмите Viper: против Bristleback +4,9% (13 200 игр).' }).badFormat).toBe(false);
  });
});

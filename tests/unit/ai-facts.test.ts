import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGrounding, extractNumbers, highlightUnverified } from '../../src/core/ai/grounding';
import { assembleFacts, findHeroes, findItems, findMechanics, mentions, mmss, normalize } from '../../src/core/ai/facts';
import { HERO_ALIASES, ITEM_ALIASES } from '../../src/core/ai/aliases';
import { afterMatchFromGsi, afterMatchFromState } from '../../src/core/ai/after-match';
import { phraseCard, renderTemplate, type CoachCard } from '../../src/core/ai/card';
import { buildAskPrompt, limitFacts, MAX_FACTS } from '../../src/core/ai/prompt';
import type { AiProvider } from '../../src/core/ai/provider';
import { mapGsi } from '../../src/core/gsi/index';
import type { GsiReading } from '../../src/core/gsi/map';
import { MatchStateModel } from '../../src/core/match-state/index';
import { deadState, gsiReading, laningState, loadKb, replayState } from '../ai/fixtures';

const kb = loadKb();

describe('проверка чисел в ответе', () => {
  it('числа, время и тысячи с пробелом', () => {
    expect(extractNumbers('Блинк стоит 2 250 золота, Рошан в 8:00, руна через 1:02:03, броня 4,2, Qwen3').map((n) => n.value)).toEqual([2250, 480, 3723, 4.2]);
  });

  it('число из фактов — проверено; выдуманное — подсвечивается', () => {
    const facts = ['Предмет Blink Dagger: цена 2250 золота', 'Рошан: Не раньше чем через — 480 с (8:00)'];
    expect(checkGrounding('Blink Dagger стоит 2250 золота.', facts).ok).toBe(true);
    // время сравнивается и как секунды: «8:00» = 480
    expect(checkGrounding('Рошан не раньше 480 секунд, то есть в 8:00.', facts).ok).toBe(true);
    // минуты сверяются с секундами фактов
    expect(checkGrounding('Рошан не раньше чем через 8 минут.', facts).ok).toBe(true);
    expect(checkGrounding('Рошан не раньше чем через 9 минут.', facts).ok).toBe(false);
    const bad = checkGrounding('Blink Dagger стоит 2300 золота, а Рошан в 9:00.', facts);
    expect(bad.ok).toBe(false);
    expect(bad.unverified.map((n) => n.text)).toEqual(['2300', '9:00']);
    const parts = highlightUnverified('Blink Dagger стоит 2300 золота, а Рошан в 9:00.', bad);
    expect(parts.filter((p) => p.flagged).map((p) => p.text)).toEqual(['2300', '9:00']);
    expect(parts.map((p) => p.text).join('')).toBe('Blink Dagger стоит 2300 золота, а Рошан в 9:00.');
  });

  it('имена латиницей, которых нет в фактах, — «не проверено»; прозвища вроде BKB — нет', () => {
    const facts = ['Предмет Black King Bar: цена 4050 золота'];
    expect(checkGrounding('Black King Bar (BKB) стоит 4050 золота.', facts, 'Сколько стоит бкб?').ok).toBe(true);
    const g = checkGrounding('The International выиграла Team Secret.', facts, 'Кто выиграл?');
    expect(g.ok).toBe(false);
    expect(g.unverified.map((n) => n.text)).toEqual(['The', 'International', 'Team', 'Secret']);
  });

  it('число из вопроса пользователя не считается выдумкой', () => {
    expect(checkGrounding('На 15 минуте — не знаю.', [], 'Что будет на 15 минуте?').ok).toBe(true);
  });
});

describe('поиск названий в вопросе', () => {
  it('падежи и сленг', () => {
    const t = normalize('Сколько стоит манты, бкб и блинком? Против пуджа и акса');
    for (const a of ['манта', 'бкб', 'блинк', 'пудж', 'акс']) expect(mentions(t, a), a).toBe(true);
    expect(mentions(normalize('купить в магазине'), 'маг')).toBe(false);
  });

  it('все ключи русских названий есть в базе знаний', () => {
    const heroKeys = new Set(kb.heroes.map((h) => h.key));
    const itemKeys = new Set(kb.items.map((i) => i.key));
    expect(Object.keys(HERO_ALIASES).filter((k) => !heroKeys.has(k))).toEqual([]);
    expect(Object.keys(ITEM_ALIASES).filter((k) => !itemKeys.has(k))).toEqual([]);
  });

  it('герои, предметы, механика', () => {
    expect(findHeroes(kb, 'как играть против сф и инвокера?').map((h) => h.key).sort()).toEqual(['invoker', 'nevermore']);
    expect(findItems(kb, 'Нужен ли BKB или Manta Style?').map((i) => i.key).sort()).toEqual(['black_king_bar', 'manta']);
    expect(findMechanics(kb.mechanics, 'когда респ рошана?').map((m) => m.id)).toContain('roshan-respawn');
    expect(findMechanics(kb.mechanics, 'какой основной атрибут?')).toEqual([]);
  });
});

describe('сборка фактов', () => {
  it('без матча и без совпадений — честно «нет данных»', () => {
    const f = assembleFacts({ page: 'assistant', question: 'Привет', kb });
    expect(f.lines).toEqual([]);
    expect(f.used[0]).toContain('нет данных');
  });

  it('живая игра: свой герой, предметы, союзники и враги, события карты; неизвестное — явно', () => {
    const f = assembleFacts({ page: 'live', question: 'что сейчас?', match: laningState(), kb });
    const text = f.lines.join('\n');
    expect(text).toContain('Мой герой Shadow Fiend: уровень 7, золото 1335');
    expect(text).toContain('Враги: Juggernaut (жив); Lina (мёртв, возродится в 8:25)');
    expect(text).toContain('Ближайшие события карты');
    expect(text).toContain('Мои способности: Shadowraze');
    expect(f.used.some((u) => u.startsWith('Текущий матч'))).toBe(true);
    const replay = assembleFacts({ page: 'replay', question: 'что в записи?', match: replayState(), replay: true, kb });
    expect(replay.lines.join('\n')).toContain('здоровье неизвестно');
    expect(replay.used).toContain('Разбор записи: модель матча по кадрам');
  });

  it('история после матча и то, что показывает страница', () => {
    const f = assembleFacts({ page: 'summary', kb, history: { label: 'матч 2026-10-14', lines: ['Смерти (1): 10:00'] }, extra: ['Открыта запись: Blink Dagger'] });
    expect(f.lines).toEqual(['Открыта запись: Blink Dagger', 'Смерти (1): 10:00']);
    expect(f.used).toEqual(['История: матч 2026-10-14']);
  });

  it('подсказка обрезается по пределам контекста, факты — в системной части', () => {
    expect(limitFacts(Array.from({ length: 200 }, (_, i) => `факт ${i}`)).length).toBeLessThanOrEqual(MAX_FACTS);
    const p = buildAskPrompt('Сколько стоит блинк?', ['Предмет Blink Dagger: цена 2250 золота']);
    expect(p.system).toContain('ТОЛЬКО факты');
    expect(p.system).toContain('не знаю');
    expect(p.system).toContain('- Предмет Blink Dagger: цена 2250 золота');
    expect(p.messages).toEqual([{ role: 'user', content: 'Сколько стоит блинк?' }]);
  });
});

describe('разбор матча: факты после матча', () => {
  it('из записанной сессии GSI: смерти со временем, кривая, предметы, простои; руны — неизвестно', () => {
    const lines = readFileSync(join(import.meta.dirname, '../fixtures/gsi/session.jsonl'), 'utf8').trim().split('\n');
    const rs = lines.map((l) => mapGsi(JSON.parse(l).body)).filter((r): r is GsiReading => !!r);
    const f = afterMatchFromGsi(rs);
    expect(f.hero).toBeTruthy();
    expect(f.lines.join('\n')).toContain('Руны и пропущенные события карты: неизвестно');

    // синтетический матч: 12 минут, смерть на 6:00, Blink Dagger на 9:00, стоял на месте с 2:00 до 4:00
    const base = gsiReading('laning');
    const synth: GsiReading[] = [];
    for (let c = 0; c <= 720; c += 2) {
      const dead = c >= 360 && c < 380;
      const idle = c >= 120 && c <= 240;
      synth.push({
        ...base,
        clock: c,
        paused: false,
        gold: 600 + c,
        hero: { ...base.hero, alive: !dead, level: 1 + Math.floor(c / 60), x: idle ? -1000 : -1000 + c * 5, y: 0 },
        kda: { kills: 0, deaths: c >= 360 ? 1 : 0, assists: 0 },
        items: c >= 540 ? [{ slot: 'inv1', key: 'blink', name: 'Blink Dagger', charges: null, cooldownSec: null }] : [],
      });
    }
    const s = afterMatchFromGsi(synth).lines.join('\n');
    expect(s).toContain('Смерти (1): 6:00 (уровень 7, золото 960)');
    expect(s).toContain('5:00 — уровень 6, золото 900');
    expect(s).toContain('Blink Dagger — 9:00');
    expect(s).toContain('2:00–4:00 (120 с)');
  });

  it('из модели «Разбора записи»: только журнал событий; чего нет — «неизвестно»', () => {
    const f = afterMatchFromState(replayState());
    expect(f.lines.join('\n')).toContain('Смерти (1): 10:12');
    expect(f.lines.join('\n')).toContain('Уровни: 8 — 10:12');
    expect(f.lines.join('\n')).toContain('Кривая золота, простои и руны: неизвестно');
    expect(afterMatchFromState(new MatchStateModel().snapshot(0)).lines[0]).toContain('не определён');
    expect(afterMatchFromState(deadState()).hero).toBe('Shadow Fiend');
    expect(mmss(-30)).toBe('-0:30');
  });
});

describe('phraseCard: фраза ИИ или шаблон за 1 секунду', () => {
  const card: CoachCard = { type: 'low-hp', facts: { hp: 120, max: 980 }, severity: 'danger' };
  const provider = (text: string, delayMs = 0): AiProvider => ({
    id: 'mock',
    async *generate(req) {
      if (delayMs) await new Promise((r, j) => {
        const t = setTimeout(r, delayMs);
        req.signal?.addEventListener('abort', () => (clearTimeout(t), j(new Error('abort'))));
      });
      yield text;
    },
  });

  it('без ИИ — шаблон', async () => {
    expect(renderTemplate(card)).toBe('Мало здоровья: 120 из 980');
    expect(await phraseCard(card)).toEqual({ text: 'Мало здоровья: 120 из 980', source: 'template', reason: 'no-provider' });
  });

  it('ИИ успел — его фраза', async () => {
    expect(await phraseCard(card, { provider: provider('Осталось 120 здоровья из 980 — отступи.') })).toEqual({ text: 'Осталось 120 здоровья из 980 — отступи.', source: 'ai', reason: null });
  });

  it('не успел за timeoutMs — шаблон; выдуманное число — шаблон', async () => {
    const t0 = Date.now();
    expect((await phraseCard(card, { provider: provider('поздно', 2000), timeoutMs: 100 })).reason).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await phraseCard(card, { provider: provider('Осталось 50 здоровья!') })).toMatchObject({ source: 'template', reason: 'ungrounded' });
  });
});

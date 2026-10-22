// Звуковые сигналы: определения (src/core/sound/cues.ts), когда звучат (director.ts), настройки и старые файлы.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SOUND_CUES, SOUND_CUE_IDS, SOUND_TOGGLE_NOTES, cueForHint, cueInFight, cuePriority, soundLengthMs, type SoundCueId, type SoundTier } from '../../src/core/sound/cues.ts';
import { SOUND_MAX_AGE_MS, SOUND_MIN_GAP_MS, SoundDirector, enabledCues, ultStateOf, type SoundTick, type UltState } from '../../src/core/sound/director.ts';
import { SOUND_SHORTCUT_DEFAULT, applySettingsPatch, defaultSettings, settingsPatchSchema, settingsSchema, type Settings } from '../../src/shared/schemas/settings.ts';
import { CoachService } from '../../src/main/coach/service';
import { renderTone, toWav } from '../../src/core/sound/render.ts';
import { realData, sim, type SimInput } from './coach-sim';

const ALL = new Set<SoundCueId>(SOUND_CUE_IDS);
const H = {
  danger: { ruleId: 'danger.missing', category: 'danger', priority: 'critical' },
  ult: { ruleId: 'fight.ult-ready', category: 'fight', priority: 'info' },
  item: { ruleId: 'economy.gold', category: 'economy', priority: 'advice', icon: 'item:black_king_bar' },
  rune: { ruleId: 'timing.rune-power', category: 'timing', priority: 'info' },
  timing: { ruleId: 'timing.stack', category: 'timing', priority: 'info' },
  review: { ruleId: 'review.death', category: 'review', priority: 'advice' },
};

/** Прогон директора: события по времени (мс) → что прозвучало и когда */
function run(events: { ms: number; shown?: SoundTick['shown']; ult?: UltState; inFight?: boolean; inGame?: boolean; enabled?: Set<SoundCueId> }[], stepMs = 250, endMs?: number) {
  const d = new SoundDirector();
  const out: { ms: number; cue: SoundCueId }[] = [];
  const last = endMs ?? Math.max(...events.map((e) => e.ms)) + 3000;
  let ult: UltState = null;
  let inFight = false;
  for (let ms = 0; ms <= last; ms += stepMs) {
    const evs = events.filter((e) => e.ms === ms);
    for (const e of evs) {
      if (e.ult !== undefined) ult = e.ult;
      if (e.inFight !== undefined) inFight = e.inFight;
    }
    const cue = d.tick({ nowMs: ms, shown: evs.flatMap((e) => e.shown ?? []), ult, inFight, inGame: evs.find((e) => e.inGame !== undefined)?.inGame ?? true, enabled: evs.find((e) => e.enabled)?.enabled ?? ALL });
    if (cue) out.push({ ms, cue });
  }
  return out;
}

describe('определения сигналов', () => {
  it('каждый сигнал 150–400 мс с затуханием, мягкие волны, громкость нот ≤ 0,6', () => {
    for (const id of SOUND_CUE_IDS) {
      const len = soundLengthMs(id);
      expect(len, id).toBeGreaterThanOrEqual(150);
      expect(len, id).toBeLessThanOrEqual(400);
      for (const n of SOUND_CUES[id].notes) {
        expect(['sine', 'triangle']).toContain(n.wave);
        expect(n.gain).toBeGreaterThan(0);
        expect(n.gain).toBeLessThanOrEqual(0.6);
        expect(n.freq).toBeGreaterThanOrEqual(100);
        expect(n.freq).toBeLessThanOrEqual(2500);
      }
    }
    for (const t of ['toggle-on', 'toggle-off'] as const) expect(soundLengthMs(t)).toBeLessThanOrEqual(300);
  });
  it('у каждого смысла свой звук: последовательности нот не повторяются; вкл и выкл — зеркальны', () => {
    const sig = SOUND_CUE_IDS.map((id) => SOUND_CUES[id].notes.map((n) => `${n.freq}@${n.startMs}`).join(','));
    expect(new Set(sig).size).toBe(SOUND_CUE_IDS.length);
    expect(SOUND_TOGGLE_NOTES['toggle-on'].map((n) => n.freq)).toEqual([...SOUND_TOGGLE_NOTES['toggle-off'].map((n) => n.freq)].reverse());
  });
  it('ноты созвучны: интервалы между нотами сигнала — кварта, квинта, терция или октава (без секунд и тритона)', () => {
    const semis = (a: number, b: number) => Math.round(Math.abs(12 * Math.log2(a / b))) % 12;
    for (const id of SOUND_CUE_IDS) {
      const f = SOUND_CUES[id].notes.map((n) => n.freq);
      for (const a of f) for (const b of f) expect([0, 3, 4, 5, 7, 8, 9], `${id}: ${a}/${b}`).toContain(semis(a, b));
    }
  });
  it('опасность важнее всех; срочные важнее советов, советы — фоновых; в драке звучат только срочные', () => {
    for (const id of SOUND_CUE_IDS) if (id !== 'danger') expect(cuePriority('danger')).toBeGreaterThan(cuePriority(id));
    const rank: Record<SoundTier, number> = { urgent: 3, advice: 2, background: 1 };
    for (const a of SOUND_CUE_IDS) for (const b of SOUND_CUE_IDS) if (rank[SOUND_CUES[a].tier] > rank[SOUND_CUES[b].tier]) expect(cuePriority(a), `${a} > ${b}`).toBeGreaterThan(cuePriority(b));
    expect(SOUND_CUE_IDS.filter(cueInFight)).toEqual(['danger', 'retreat', 'engage']);
  });
  it('один стиль, громкость по срочности: срочные ярче и громче, фоновые тихие и мягкие', () => {
    const peak = (id: SoundCueId) => Math.max(...renderTone(id, 1).map(Math.abs));
    const by = (t: SoundTier) => SOUND_CUE_IDS.filter((id) => SOUND_CUES[id].tier === t);
    const minUrgent = Math.min(...by('urgent').map(peak));
    const maxAdvice = Math.max(...by('advice').map(peak));
    const minAdvice = Math.min(...by('advice').map(peak));
    const maxBg = Math.max(...by('background').map(peak));
    expect(minUrgent).toBeGreaterThan(maxAdvice);
    expect(minAdvice).toBeGreaterThan(maxBg);
    // фоновые — заметно тише срочных (не меньше чем вдвое)
    expect(maxBg * 2).toBeLessThan(minUrgent);
    for (const id of by('urgent')) expect(SOUND_CUES[id].notes.some((n) => n.wave === 'triangle'), id).toBe(true);
    for (const id of by('background')) for (const n of SOUND_CUES[id].notes) {
      expect(n.wave, id).toBe('sine');
      expect(n.attackMs ?? 0, id).toBeGreaterThanOrEqual(20);
    }
    // в каждом уровне несколько сигналов, все разные
    for (const t of ['urgent', 'advice', 'background'] as const) expect(by(t).length).toBeGreaterThanOrEqual(3);
  });
});

describe('подсказка → сигнал', () => {
  it('по правилу и категории', () => {
    for (const [cue, h] of Object.entries(H)) expect(cueForHint(h), cue).toBe(cue);
    expect(cueForHint({ ruleId: 'fight.disengage', category: 'fight', priority: 'critical' })).toBe('retreat');
    expect(cueForHint({ ruleId: 'danger.low-hp', category: 'danger', priority: 'critical' })).toBe('retreat');
    expect(cueForHint({ ruleId: 'fight.engage', category: 'fight', priority: 'advice' })).toBe('engage');
    expect(cueForHint({ ruleId: 'economy.tp', category: 'economy', priority: 'advice' })).toBe('buy');
    expect(cueForHint({ ruleId: 'economy.skill', category: 'economy', priority: 'advice' })).toBe('skill');
    expect(cueForHint({ ruleId: 'economy.idle', category: 'economy', priority: 'advice' })).toBe('farm');
    expect(cueForHint({ ruleId: 'macro.push', category: 'macro', priority: 'advice' })).toBe('team');
    expect(cueForHint({ ruleId: 'danger.building', category: 'danger', priority: 'critical' })).toBe('building');
    expect(cueForHint({ ruleId: 'economy.next', category: 'economy', priority: 'info', icon: 'item:blink' })).toBe('shop');
    expect(cueForHint({ ruleId: 'economy.gold', category: 'economy', priority: 'advice', icon: null })).toBe('shop');
    expect(cueForHint({ ruleId: 'macro.outpost', category: 'macro', priority: 'info' })).toBe('map');
    expect(cueForHint({ id: 'fight.action:retreat', ruleId: 'fight.action', category: 'fight', priority: 'advice' })).toBe('retreat');
    expect(cueForHint({ id: 'fight.action:farm', ruleId: 'fight.action', category: 'fight', priority: 'info' })).toBe('map');
    expect(cueForHint({ ruleId: 'timing.rune-bounty', category: 'timing', priority: 'info' })).toBe('rune');
    expect(cueForHint({ ruleId: 'timing.roshan-respawn', category: 'timing', priority: 'info' })).toBe('timing');
    expect(cueForHint({ ruleId: 'review.match', category: 'review', priority: 'advice' })).toBe('review');
  });
  it('у каждого правила коуча есть свой звук (неизвестное правило — без звука)', () => {
    const rules = new Set<string>();
    const dir = join(import.meta.dirname, '../../src/core/coach');
    for (const f of [...readdirSync(join(dir, 'rules')).map((x) => join(dir, 'rules', x)), join(dir, 'engine.ts')]) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:ruleId|id): [`']([a-z]+\.[a-z0-9-]+)/g)) rules.add(m[1]!);
    }
    expect(rules.size).toBeGreaterThan(40);
    const silent = [...rules].filter((r) => !cueForHint({ ruleId: r, category: r.split('.')[0]!, priority: 'advice', icon: 'item:x' }));
    expect(silent).toEqual([]);
    expect(cueForHint({ ruleId: 'new.rule', category: 'macro', priority: 'info' })).toBeNull();
  });
});

describe('когда звучит', () => {
  it('один момент — один звук: опасность и тайминг сразу → опасность; тайминг следом, если ещё свежий', () => {
    const out = run([{ ms: 0, shown: [H.timing, H.danger] }]);
    expect(out[0]).toEqual({ ms: 0, cue: 'danger' });
    // тайминг ждал 1,5 с (≤ 2 с) — звучит
    expect(out[1]).toEqual({ ms: SOUND_MIN_GAP_MS, cue: 'timing' });
    expect(out).toHaveLength(2);
  });
  it('не чаще раза в 1,5 с; сигнал старше 2 с выбрасывается', () => {
    const out = run([{ ms: 0, shown: [H.danger, H.ult, H.item, H.rune, H.timing] }]);
    expect(out.map((x) => x.cue)).toEqual(['danger', 'ult']);
    // срочный сигнал вперёд советов и фоновых
    expect(run([{ ms: 0, shown: [H.timing, H.item, { ruleId: 'fight.disengage', category: 'fight', priority: 'critical' }] }])[0]!.cue).toBe('retreat');
    for (let i = 1; i < out.length; i++) expect(out[i]!.ms - out[i - 1]!.ms).toBeGreaterThanOrEqual(SOUND_MIN_GAP_MS);
    expect(Math.max(...out.map((x) => x.ms))).toBeLessThanOrEqual(SOUND_MAX_AGE_MS);
  });
  it('не срочных — не больше 2 в минуту; срочные проходят и после лимита', () => {
    const calm = [H.item, H.rune, H.timing, H.review, { ruleId: 'macro.push', category: 'macro', priority: 'advice' }];
    const evs = calm.map((h, i) => ({ ms: i * 5000, shown: [h] }));
    const out = run([...evs, { ms: 30_000, shown: [H.danger] }]);
    expect(out.map((x) => x.cue)).toEqual(['item', 'rune', 'danger']);
    // через минуту лимит снова свободен
    const later = run([...evs, { ms: 61_000, shown: [H.review] }]);
    expect(later.map((x) => x.cue)).toEqual(['item', 'rune', 'review']);
  });
  it('кулдаун сигнала: опасность каждые 2 с → звучит раз в 8 с', () => {
    const evs = Array.from({ length: 10 }, (_, i) => ({ ms: i * 2000, shown: [H.danger] }));
    const out = run(evs);
    expect(out.map((x) => x.ms)).toEqual([0, 8000, 16000]);
  });
  it('в драке звучат только срочные, остальное не копится до конца драки', () => {
    const out = run([{ ms: 0, inFight: true, shown: [H.timing, H.rune, H.ult] }, { ms: 500, shown: [H.danger] }, { ms: 2500, shown: [{ ruleId: 'fight.target', category: 'fight', priority: 'advice' }] }, { ms: 4000, inFight: false }]);
    expect(out).toEqual([{ ms: 500, cue: 'danger' }, { ms: 2500, cue: 'engage' }]);
  });
  it('выключенный сигнал не звучит и не мешает другим', () => {
    const enabled = new Set<SoundCueId>(['timing']);
    const out = run([{ ms: 0, shown: [H.danger, H.timing], enabled }]);
    expect(out).toEqual([{ ms: 0, cue: 'timing' }]);
  });
  it('ульта: «перезарядка → готова» звучит; первый снимок (подключение к матчу) — нет; нет маны — не ульта', () => {
    expect(run([{ ms: 0, ult: 'ready' }])).toEqual([]);
    expect(run([{ ms: 0, ult: 'cooldown' }, { ms: 1000, ult: 'ready' }])).toEqual([{ ms: 1000, cue: 'ult' }]);
    expect(run([{ ms: 0, ult: 'unlearned' }, { ms: 1000, ult: 'ready' }])).toEqual([{ ms: 1000, cue: 'ult' }]);
    expect(run([{ ms: 0, ult: 'other' }, { ms: 1000, ult: 'ready' }])).toEqual([]);
  });
  it('ульта по данным игры и подсказка «Ульта готова» в тот же момент — один звук', () => {
    const out = run([{ ms: 0, ult: 'cooldown' }, { ms: 1000, ult: 'ready', shown: [H.ult] }, { ms: 3000, shown: [H.ult] }]);
    expect(out).toEqual([{ ms: 1000, cue: 'ult' }]);
  });
  it('начало игры: пачки сигналов нет — при подключении много подсказок сразу → один звук, остальные выброшены', () => {
    const out = run([{ ms: 0, ult: 'ready', shown: [H.timing, H.rune, H.item, H.review] }]);
    expect(out.length).toBeLessThanOrEqual(2);
    expect(out[0]!.cue).toBe('item');
  });
  it('вне матча ульта забывается: новый матч начинается без звука «готова»', () => {
    // старый матч: ульта на перезарядке; между матчами (вне игры) — уже готова; первый снимок нового матча — молча
    const out = run([{ ms: 0, ult: 'cooldown' }, { ms: 500, inGame: false, ult: 'ready' }, { ms: 750, ult: 'ready' }]);
    expect(out).toEqual([]);
  });
  it('enabledCues: отсутствующий в настройках сигнал — включён', () => {
    expect([...enabledCues({ danger: false })].sort()).toEqual(SOUND_CUE_IDS.filter((x) => x !== 'danger').sort());
  });
});

describe('состояние ульты', () => {
  const v = (a: object | null) => ({ me: { abilities: a ? [{ ultimate: true, level: 1, passive: false, state: null, cooldownSec: 0, ...a }] : [] } });
  it('готова / перезарядка / не изучена / пассивная / нет маны', () => {
    expect(ultStateOf(v({ state: 'ready' }))).toBe('ready');
    expect(ultStateOf(v({ state: 'cooldown', cooldownSec: 40 }))).toBe('cooldown');
    expect(ultStateOf(v({ state: null, cooldownSec: 12 }))).toBe('cooldown');
    expect(ultStateOf(v({ level: 0 }))).toBe('unlearned');
    expect(ultStateOf(v({ passive: true }))).toBeNull();
    expect(ultStateOf(v({ state: 'no-mana' }))).toBe('other');
    expect(ultStateOf(v(null))).toBeNull();
    expect(ultStateOf(null)).toBeNull();
  });
});

describe('настройки звука', () => {
  const dir = join(import.meta.dirname, '../fixtures/settings');
  it('по умолчанию: включено, громкость 30%, все сигналы, Ctrl+Alt+S', () => {
    const s = defaultSettings().sound;
    expect(s).toEqual({ enabled: true, volume: 0.3, cues: Object.fromEntries(SOUND_CUE_IDS.map((c) => [c, true])), shortcut: SOUND_SHORTCUT_DEFAULT });
  });
  it('старые файлы настроек (0.7.1 … 0.13.2) загружаются: раздел звука — по умолчанию, остальное не тронуто', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const s = settingsSchema.parse(raw);
      expect(s.sound, f).toEqual(defaultSettings().sound);
      if (raw.hints?.enabled !== undefined) expect(s.hints.enabled, f).toBe(raw.hints.enabled);
    }
  });
  it('файл 0.16.x (как у друга: все разделы, звука нет) — звук по умолчанию', () => {
    const { sound: _drop, ...old } = defaultSettings();
    void _drop;
    old.hints.detail = 'min';
    const s = settingsSchema.parse(JSON.parse(JSON.stringify(old)));
    expect(s.sound).toEqual(defaultSettings().sound);
    expect(s.hints.detail).toBe('min');
  });
  it('файл 0.16.4 (6 сигналов): выбор пользователя сохраняется, новые сигналы — включены', () => {
    const old = { sound: { enabled: false, volume: 0.45, cues: { danger: true, ult: false, item: true, rune: false, timing: true, review: true }, shortcut: 'Ctrl+Alt+F10' } };
    const s = settingsSchema.parse(old);
    expect(s.sound.enabled).toBe(false);
    expect(s.sound.volume).toBe(0.45);
    expect(s.sound.shortcut).toBe('Ctrl+Alt+F10');
    expect(s.sound.cues).toMatchObject({ ult: false, rune: false, danger: true });
    for (const id of SOUND_CUE_IDS) if (!(id in old.sound.cues)) expect(s.sound.cues[id], id).toBe(true);
  });
  it('испорченные значения → по умолчанию по одному полю; часть сигналов сохраняется', () => {
    const s = settingsSchema.parse({ sound: { enabled: 'да', volume: 7, cues: { danger: false, rune: 'x', unknown: true }, shortcut: 'S' } });
    expect(s.sound.enabled).toBe(true);
    expect(s.sound.volume).toBe(0.3);
    expect(s.sound.cues.danger).toBe(false);
    expect(s.sound.cues.rune).toBe(true);
    expect(s.sound.cues).not.toHaveProperty('unknown');
    expect(s.sound.shortcut).toBe(SOUND_SHORTCUT_DEFAULT);
    expect(settingsSchema.parse({ sound: 'мусор' }).sound).toEqual(defaultSettings().sound);
    expect(settingsSchema.parse({ sound: { cues: null } }).sound.cues).toEqual(defaultSettings().sound.cues);
  });
  it('изменение из интерфейса: один сигнал не сбрасывает остальные; недопустимое — ошибка', () => {
    const cur = applySettingsPatch(defaultSettings(), settingsPatchSchema.parse({ sound: { cues: { rune: false } } }));
    const next = applySettingsPatch(cur, settingsPatchSchema.parse({ sound: { cues: { timing: false }, volume: 0.5 } }));
    expect(next.sound.cues).toMatchObject({ rune: false, timing: false, danger: true });
    expect(next.sound.volume).toBe(0.5);
    expect(() => settingsPatchSchema.parse({ sound: { volume: 2 } })).toThrow();
    expect(() => settingsPatchSchema.parse({ sound: { shortcut: 'S' } })).toThrow();
    expect(() => settingsPatchSchema.parse({ sound: { cues: { bark: true } } })).toThrow();
    expect(settingsPatchSchema.parse({ sound: { shortcut: '' } }).sound!.shortcut).toBe('');
  });
});

describe('звук в сервисе коуча', () => {
  const data = realData();
  const kb = { get: () => ({ meta: { patch: '7.41f', verification: 'imported-unverified' }, heroes: data.heroes, items: data.items, mechanics: data.mechanics }) as never, stats: () => data.stats };
  const danger = (t: number): Partial<SimInput> => ({
    pos: { x: 3000, y: 2500 },
    hp: 200,
    items: [{ slot: 'inv1', key: 'boots' }],
    enemies: [...[5, 6].map((slot) => ({ slot, hero: 'axe', pos: { x: 3400, y: 2600 } })), { slot: 7, hero: 'axe', pos: null, missingForSec: 10 + t }],
  });
  function make(settings: Settings, onSound: (cue: SoundCueId) => void) {
    let now = 0;
    const hints: number[] = [];
    const svc = new CoachService({ settings: { get: () => settings }, kb, aiProvider: () => null, history: { save() {} }, onHints: (h) => hints.push(h.length), onSound, now: () => now });
    for (let t = 0; t < 5; t++) {
      now = 1_000_000 + t * 1000;
      const s = sim({ wallMs: now, clock: 600 + t, ...danger(t) });
      svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: now });
    }
    return hints;
  }
  it('опасность на экране (двое врагов вплотную, мало здоровья) → один срочный сигнал', () => {
    const cues: SoundCueId[] = [];
    make(defaultSettings(), (c) => cues.push(c));
    const urgent = cues.filter(cueInFight);
    expect(urgent.length).toBeGreaterThanOrEqual(1);
    expect(new Set(urgent).size).toBe(urgent.length);
  });
  it('звук выключен, сигнал выключен или категория подсказок выключена — тишина', () => {
    const d = defaultSettings();
    for (const s of [applySettingsPatch(d, { sound: { enabled: false } }), applySettingsPatch(d, { sound: { cues: { danger: false } } }), applySettingsPatch(d, { hints: { categories: { ...d.hints.categories, danger: false } } })]) {
      const cues: SoundCueId[] = [];
      make(s, (c) => cues.push(c));
      expect(cues.filter((c) => c === 'danger')).toEqual([]);
    }
  });
  it('сбой звука не ломает подсказки', () => {
    const hints = make(defaultSettings(), () => {
      throw new Error('нет звуковой карты');
    });
    expect(Math.max(...hints)).toBeGreaterThan(0);
  });
});

describe('звук без щелчков (тот же расчёт огибающей, что в окне коуча)', () => {
  it('начало и конец — тишина, нет скачков, пик при громкости 30% — тихий', () => {
    for (const id of [...SOUND_CUE_IDS, 'toggle-on', 'toggle-off'] as const) {
      const s = renderTone(id, 0.3);
      expect(Math.abs(s[0]!), id).toBeLessThan(0.001);
      expect(Math.abs(s[s.length - 1]!), id).toBeLessThan(0.001);
      let peak = 0;
      let jump = 0;
      for (let i = 1; i < s.length; i++) {
        peak = Math.max(peak, Math.abs(s[i]!));
        jump = Math.max(jump, Math.abs(s[i]! - s[i - 1]!));
      }
      expect(peak, id).toBeLessThan(0.35);
      expect(peak, id).toBeGreaterThan(0.02);
      // скачок за отсчёт не больше, чем у чистого синуса самой высокой ноты с пиковой громкостью (щелчок — много больше)
      const fmax = Math.max(...(id.startsWith('toggle') ? [800] : SOUND_CUES[id as SoundCueId].notes.map((n) => n.freq)));
      expect(jump, id).toBeLessThanOrEqual(peak * 2 * Math.PI * (fmax / 44_100) * 1.6 + 1e-3);
    }
  });
  it('WAV: заголовок и длина', () => {
    const w = toWav(renderTone('danger', 0.3));
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF');
    expect(w.length).toBeGreaterThan(44 + 2 * 44_100 * 0.3);
  });
});

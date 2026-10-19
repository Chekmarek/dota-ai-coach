// «Плохой совет» (горячая клавиша): отметка сохраняется с подсказками и 15 с состояния, вне матча ничего не пишется,
// ники, steamid и чат в отметку не попадают; сбор отметок в один файл; безопасные сочетания клавиш.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoachService } from '../../src/main/coach/service';
import { HistoryStore } from '../../src/main/coach/history';
import { BadAdviceStore, MAX_SESSIONS } from '../../src/main/coach/bad-advice-store';
import { BAD_ADVICE_WINDOW_MS, badAdviceReport, type BadAdviceRecord } from '../../src/core/coach/bad-advice';
import { mapGsi } from '../../src/core/gsi/index';
import { BAD_ADVICE_SHORTCUT_DEFAULT, acceleratorOf, defaultSettings, isSafeBadAdviceShortcut, settingsSchema } from '../../src/shared/schemas/settings';
import { realData, sim, type SimInput } from './coach-sim';

const data = realData();
const kb = {
  get: () => ({ meta: { patch: '7.41f', verification: 'imported-unverified' }, heroes: data.heroes, items: data.items, mechanics: data.mechanics }) as never,
  stats: () => data.stats,
};

function make(session = 'sess-1') {
  const dir = mkdtempSync(join(tmpdir(), 'bad-advice-'));
  const history = new HistoryStore(dir);
  const store = new BadAdviceStore(dir, session);
  let now = 0;
  const svc = new CoachService({ settings: { get: () => defaultSettings() }, kb, aiProvider: () => null, history, badAdvice: store, appVersion: '0.0.0-test', onHints: () => {}, now: () => now });
  const feed = (t: number, i: Partial<SimInput> = {}, patch?: (s: ReturnType<typeof sim>) => void) => {
    now = 1_000_000 + t * 1000;
    const s = sim({ wallMs: now, clock: 600 + t, ...i });
    patch?.(s);
    svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: now });
  };
  const files = () => (existsSync(join(dir, 'bad-advice', session)) ? readdirSync(join(dir, 'bad-advice', session)) : []);
  return { dir, svc, feed, history, files, setNow: (t: number) => (now = 1_000_000 + t * 1000) };
}

// Опасность, о которой предупреждает и модель опасности (она заменила правила о риске): мало здоровья, двое врагов
// вплотную, третий пропал. Раньше было «трое пропали» — на такой обстановке модель риска смерти за 15 с не видит
const danger = (t: number): Partial<SimInput> => ({
  pos: { x: 3000, y: 2500 },
  hp: 200,
  items: [{ slot: 'inv1', key: 'boots' }],
  enemies: [...[5, 6].map((slot) => ({ slot, hero: 'axe', pos: { x: 3400, y: 2600 } })), { slot: 7, hero: 'axe', pos: null, missingForSec: 10 + t }],
});

describe('«Плохой совет»', () => {
  it('отметка сохраняется: подсказки на экране, игровое время, снимки за последние 15 с; видна в «Истории советов»', () => {
    const { svc, feed, history, files } = make();
    for (let t = 0; t < 30; t++) feed(t, danger(t));
    const r = svc.markBadAdvice()!;
    expect(r).not.toBeNull();
    expect(r.clock).toBe(629);
    expect(r.matchId).toBe('123');
    expect(r.onScreen.length).toBeGreaterThan(0);
    expect(r.recent.length).toBeGreaterThanOrEqual(r.onScreen.length);
    // снимки — только за окно 15 с, по порядку, последний — момент нажатия
    expect(r.snapshots.length).toBeGreaterThanOrEqual(14);
    expect(r.snapshots.at(-1)!.wallMs - r.snapshots[0]!.wallMs).toBeLessThanOrEqual(BAD_ADVICE_WINDOW_MS);
    expect(r.snapshots.at(-1)!.clock).toBe(629);
    expect(r.snapshots.at(-1)!.me.hp?.current).toBe(200);
    // файл отметки
    expect(files()).toEqual([`${r.id}.json`]);
    // в файле матча «Истории советов» и в списке
    const m = history.get(r.historyId!)!;
    expect(m.badAdvice).toEqual([{ id: r.id, markedAt: r.markedAt, clock: 629, titles: r.onScreen.map((h) => h.title) }]);
    expect(history.list()[0]!.badAdvice).toBe(1);
  });

  it('вне матча клавиша ничего не пишет: до первого снимка, в меню и после конца матча', () => {
    const { dir, svc, feed, files } = make();
    expect(svc.markBadAdvice()).toBeNull();
    for (let t = 0; t < 5; t++) feed(t, { phase: 'pre-game', clock: -200 + t });
    expect(svc.markBadAdvice()).toBeNull();
    for (let t = 5; t < 15; t++) feed(t, { level: 10 });
    for (let t = 15; t < 20; t++) feed(t, { level: 10, phase: 'post-game', winTeam: 'radiant' });
    expect(svc.markBadAdvice()).toBeNull();
    expect(files()).toEqual([]);
    expect(existsSync(join(dir, 'bad-advice'))).toBe(false);
  });

  it('подсказки выключены — отметка не пишется', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-advice-'));
    const off = { ...defaultSettings(), hints: { ...defaultSettings().hints, enabled: false } };
    let now = 0;
    const svc = new CoachService({ settings: { get: () => off }, kb, aiProvider: () => null, history: new HistoryStore(dir), badAdvice: new BadAdviceStore(dir, 's'), onHints: () => {}, now: () => now });
    for (let t = 0; t < 5; t++) {
      now = 1_000_000 + t * 1000;
      const s = sim({ wallMs: now, clock: 600 + t });
      svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: now });
    }
    expect(svc.markBadAdvice()).toBeNull();
    expect(existsSync(join(dir, 'bad-advice'))).toBe(false);
  });

  it('приватное не попадает: ник, steamid, accountid из GSI и «чат» в состоянии матча', () => {
    const { svc, feed, files, dir } = make();
    // Настоящее тело GSI с личными полями → то же чтение, что в коуче (mapGsi)
    const body = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/gsi/laning.json'), 'utf8'));
    body.player = { ...body.player, name: 'SECRET_NICK', steamid: '76561198000000001', accountid: '39734273', steam_name: 'SECRET_STEAM' };
    body.chat = [{ text: 'SECRET_CHAT gg' }];
    const fromBody = mapGsi(body)!;
    expect(fromBody).not.toBeNull();
    // чтение GSI коуча личных полей не несёт
    expect(JSON.stringify(fromBody)).not.toMatch(/SECRET|76561198000000001|39734273/);
    for (let t = 0; t < 20; t++)
      feed(t, danger(t), (s) => {
        // ник и steamid — во всех местах, куда их могли бы протащить
        Object.assign(s.gsi!, { player: body.player, playerName: 'SECRET_NICK', raw: body });
        Object.assign(s.state as object, { chat: ['SECRET_CHAT привет'], nicknames: ['SECRET_NICK'] });
        for (const p of s.state.players) Object.assign(p, { name: 'SECRET_NICK', steamid: '76561198000000001' });
      });
    const r = svc.markBadAdvice()!;
    expect(r).not.toBeNull();
    const saved = readFileSync(join(dir, 'bad-advice', 'sess-1', files()[0]!), 'utf8');
    for (const secret of ['SECRET', '76561198000000001', '39734273', 'steamid', 'accountid', 'chat']) expect(saved).not.toContain(secret);
    // и в «Истории советов»
    const hist = readFileSync(join(dir, 'history', readdirSync(join(dir, 'history'))[0]!), 'utf8');
    for (const secret of ['SECRET', '76561198000000001']) expect(hist).not.toContain(secret);
  });

  it('сбор за сессию: один Markdown с подсказками, последним состоянием и JSON по каждой отметке', () => {
    const { svc, feed } = make();
    for (let t = 0; t < 20; t++) feed(t, danger(t));
    const a = svc.markBadAdvice()!;
    for (let t = 20; t < 40; t++) feed(t, danger(t));
    const b = svc.markBadAdvice()!;
    const md = badAdviceReport([a, b], 'Плохие советы — сессия sess-1');
    expect(md).toContain('Отметок: 2');
    expect(md).toContain('## 1. 10:19');
    expect(md).toContain('## 2. 10:39');
    expect(md).toContain(a.onScreen[0]!.title);
    expect(md).toContain('врагов рядом (по коучу)');
    expect((md.match(/```json/g) ?? []).length).toBe(2);
    const json = md.split('```json\n')[1]!.split('\n```')[0]!;
    expect((JSON.parse(json) as BadAdviceRecord).id).toBe(a.id);
  });

  it('хранится не больше MAX_SESSIONS запусков', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-advice-'));
    const rec = (id: string) => ({ id }) as BadAdviceRecord;
    for (let i = 0; i < MAX_SESSIONS + 3; i++) new BadAdviceStore(dir, `s${String(i).padStart(3, '0')}`).save(rec('x'));
    const left = readdirSync(join(dir, 'bad-advice'));
    expect(left.length).toBe(MAX_SESSIONS);
    expect(left).not.toContain('s000');
  });
});

describe('клавиша «плохой совет»', () => {
  it('по умолчанию — Ctrl+Shift+F8; в старых settings.json поля нет — тоже по умолчанию; неверная — по умолчанию', () => {
    expect(defaultSettings().hints.badAdviceShortcut).toBe(BAD_ADVICE_SHORTCUT_DEFAULT);
    expect(BAD_ADVICE_SHORTCUT_DEFAULT).toBe('Ctrl+Shift+F8');
    const old = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/settings/settings-0.13.2.json'), 'utf8'));
    expect(settingsSchema.parse(old).hints.badAdviceShortcut).toBe(BAD_ADVICE_SHORTCUT_DEFAULT);
    expect(settingsSchema.parse({ ...old, hints: { ...old.hints, badAdviceShortcut: 'A' } }).hints.badAdviceShortcut).toBe(BAD_ADVICE_SHORTCUT_DEFAULT);
    expect(settingsSchema.parse({ ...old, hints: { ...old.hints, badAdviceShortcut: '' } }).hints.badAdviceShortcut).toBe('');
  });

  it('безопасные сочетания: нужен Ctrl или Alt, с буквой или цифрой — два модификатора, без Alt+F4', () => {
    for (const k of ['Ctrl+Shift+F8', 'Ctrl+F9', 'Alt+F10', 'Ctrl+Shift+B', 'Ctrl+Alt+7']) expect(isSafeBadAdviceShortcut(k)).toBe(true);
    for (const k of ['F8', 'Shift+F8', 'Shift+A', 'Ctrl+C', 'Alt+1', 'Alt+F4', 'Ctrl+Ctrl+F8', 'Ctrl+Shift+Space', 'ctrl+f8', '']) expect(isSafeBadAdviceShortcut(k)).toBe(false);
  });

  it('нажатое сочетание → строка для Electron', () => {
    expect(acceleratorOf({ ctrlKey: true, altKey: false, shiftKey: true, code: 'F8' })).toBe('Ctrl+Shift+F8');
    expect(acceleratorOf({ ctrlKey: true, altKey: true, shiftKey: false, code: 'KeyB' })).toBe('Ctrl+Alt+B');
    expect(acceleratorOf({ ctrlKey: true, altKey: false, shiftKey: false, code: 'ControlLeft' })).toBeNull();
  });
});

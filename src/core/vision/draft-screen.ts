// Экран выбора героев: большие портреты 10 игроков в полосе сверху (5 Сил Света слева, 5 Сил Тьмы справа).
// Пока идут пики, портреты своей команды видны сразу, а вражеские закрыты флажками; на стадии планирования
// открываются все 10. Сравнение — те же шаблоны портретов, что у верхней панели матча (top-bar.ts): картинка героя
// та же, только крупнее. Порядок героев на экране драфта не совпадает с номерами игроков в матче, поэтому
// результат — состав команд, а не ячейки игроков.
// Положения размечены по двум записям драфта владельца (All Pick 2026-10-12 и Турбо 2026-10-18, 1920×1080):
// все 90 видимых портретов узнаны верно (уверенность 0,63–0,99), пустые ячейки, флажки и кадры игры — не выше 0,53.
// Чистое ядро: без Electron, DOM, сети и файлов.
import { matchPortrait, portraitGrid, type PortraitTemplates, type Team } from './top-bar.ts';
import { layoutFits, type HudLayout } from './hud-layout.ts';
import type { FrameAccess } from './image.ts';

/** Ниже — ячейка считается пустой или закрытой (флажок, кадр игры): на записях такие не выше 0,53 */
export const DRAFT_MIN_CONFIDENCE = 0.6;

export interface DraftScreenSlot {
  /** Место в полосе драфта слева направо (0–4 — Силы Света, 5–9 — Силы Тьмы); не номер игрока в матче */
  index: number;
  team: Team;
  /** Герой; null — пусто, закрыто флажком или не узнан уверенно */
  heroKey: string | null;
  confidence: number;
}

export interface DraftScreenReading {
  /** false — кадр не 16:9 или в раскладке нет полосы драфта */
  supported: boolean;
  slots: DraftScreenSlot[];
  durationMs: number;
}

export function readDraftScreen(frame: FrameAccess, layout: HudLayout, templates: PortraitTemplates, opts: { now?: () => number } = {}): DraftScreenReading {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const db = layout.draftBar;
  if (!db || !layoutFits(layout, frame.width, frame.height)) return { supported: false, slots: [], durationMs: now() - t0 };
  const sx = frame.width / layout.reference.w, sy = frame.height / layout.reference.h;
  // Одна полоса на все 10 портретов
  const x0 = Math.floor(db.radiantX * sx), x1 = Math.ceil((db.direX + 4 * db.step + db.w) * sx);
  const y0 = Math.floor(db.y * sy), y1 = Math.ceil((db.y + db.h) * sy);
  const strip = frame.read({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  const slots: DraftScreenSlot[] = [];
  for (let index = 0; index < 10; index++) {
    const team: Team = index < 5 ? 'radiant' : 'dire';
    const x = ((index < 5 ? db.radiantX : db.direX) + (index % 5) * db.step) * sx - x0;
    const grid = portraitGrid(strip, x, db.y * sy - y0, db.w * sx, db.h * sy);
    const m = matchPortrait(grid, false, templates);
    const known = m.key !== null && m.confidence >= DRAFT_MIN_CONFIDENCE;
    slots.push({ index, team, heroKey: known ? m.key : null, confidence: m.confidence });
  }
  return { supported: true, slots, durationMs: now() - t0 };
}

/** Прямоугольник полосы драфта в кадре (для копирования одной полосой) */
export function draftBarRect(layout: HudLayout, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  const db = layout.draftBar;
  if (!db) return null;
  const sx = w / layout.reference.w, sy = h / layout.reference.h;
  const x0 = Math.floor(db.radiantX * sx), y0 = Math.floor(db.y * sy);
  return { x: x0, y: y0, w: Math.ceil((db.direX + 4 * db.step + db.w) * sx) - x0, h: Math.ceil((db.y + db.h) * sy) - y0 };
}

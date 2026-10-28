// Реестр тем подсказок. Добавить тему: файл в themes/ + строка здесь + id в HUD_THEME_IDS (src/shared/types/hud.ts).
import type { HudThemeId } from '../../shared/types/hud.ts';
import type { HudTheme } from './tokens.ts';
import { COACH } from './themes/coach.ts';
import { DOTA } from './themes/dota-panel.ts';
import { TEAL } from './themes/teal.ts';
import { OBSIDIAN } from './themes/obsidian.ts';

export const THEMES: Record<HudThemeId, HudTheme> = { runes: COACH, dota: DOTA, teal: TEAL, obsidian: OBSIDIAN };
export const themeById = (id: string): HudTheme => THEMES[id as HudThemeId] ?? COACH;
export { themeVars, type HudTheme } from './tokens.ts';

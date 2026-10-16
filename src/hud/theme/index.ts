// Реестр тем подсказок. Добавить тему: файл в themes/ + строка здесь + id в HUD_THEME_IDS (src/shared/types/hud.ts).
import type { HudThemeId } from '../../shared/types/hud.ts';
import type { HudTheme } from './tokens.ts';
import { RUNES } from './themes/runes.ts';
import { OBSIDIAN } from './themes/obsidian.ts';

export const THEMES: Record<HudThemeId, HudTheme> = { runes: RUNES, obsidian: OBSIDIAN };
export const themeById = (id: string): HudTheme => THEMES[id as HudThemeId] ?? RUNES;
export { themeVars, type HudTheme } from './tokens.ts';

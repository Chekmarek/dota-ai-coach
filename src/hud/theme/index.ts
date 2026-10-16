// Реестр тем подсказок. Добавить тему: файл в themes/ + строка здесь + id в HUD_THEME_IDS (src/shared/types/hud.ts).
import type { HudThemeId } from '../../shared/types/hud.ts';
import type { HudTheme } from './tokens.ts';
import { ARCANE } from './themes/arcane.ts';
import { VOID } from './themes/void.ts';

export const THEMES: Record<HudThemeId, HudTheme> = { arcane: ARCANE, void: VOID };
export const themeById = (id: string): HudTheme => THEMES[id as HudThemeId] ?? ARCANE;
export { themeVars, type HudTheme } from './tokens.ts';

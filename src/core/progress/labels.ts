// Подписи для прогресса: названия ошибок и фокусов. Чистое ядро.
import { MISTAKE_RU } from '../coach/mistakes.ts';
import { focusById, focusTitle } from '../focus/config.ts';

export const MISTAKE_TITLE_RU: Record<string, string> = { ...MISTAKE_RU };

export function focusTitleById(id: string, turbo: boolean): string {
  const d = focusById(id);
  return d ? focusTitle(d, turbo) : id;
}

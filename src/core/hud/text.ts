// Текст плашки поверх игры. Чистое ядро.

/**
 * Причина без повтора заголовка: правила часто начинают текст с того же, что в заголовке
 * («Не вступать: шанс 31%. 3 врага рядом…») — на плашке это вдвое больше чтения.
 * Отрезается только целое совпадение до границы слова: заголовок «Фарм» не трогает текст «Фармить лес».
 */
export function reasonText(title: string, text: string): string {
  const t = title.trim().replace(/[.!…]+$/u, '');
  if (!t || !text.startsWith(t)) return text;
  const rest = text.slice(t.length);
  if (/^[\p{L}\p{N}]/u.test(rest)) return text;
  return rest.replace(/^[\s.,:;·—–-]+/u, '');
}

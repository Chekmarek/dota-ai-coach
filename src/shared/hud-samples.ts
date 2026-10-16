// Примеры подсказок каждого типа — для «Предпросмотра подсказок», демо поверх игры и снимков тем.
// Тексты — как их выдаёт движок (src/core/coach); числа условные.
import type { HudHint } from './types/hud.ts';

export type SampleScene = 'alive' | 'dead' | 'match';
export const SAMPLE_SCENES: { id: SampleScene; nameRu: string }[] = [
  { id: 'alive', nameRu: 'Игра идёт' },
  { id: 'dead', nameRu: 'Герой мёртв' },
  { id: 'match', nameRu: 'Конец матча' },
];

const base = { icon: null, source: 'template' as const, ttlMs: 9000, percent: null, review: null };

export function sampleHints(scene: SampleScene, detail: 'min' | 'normal' | 'detailed' = 'normal'): HudHint[] {
  const t = (normal: string, detailed: string) => (detail === 'min' ? '' : detail === 'detailed' ? detailed : normal);
  if (scene === 'dead')
    return [
      {
        ...base,
        seq: 101,
        zone: 'review',
        priority: 'advice',
        category: 'review',
        title: 'Разбор смерти',
        text: '',
        ttlMs: 30000,
        review: {
          kind: 'death',
          heading: 'Разбор смерти · 23:41',
          why: ['Вас поймали 3 врага', 'Смерть на стороне врага (лес Сил Тьмы)', '3 врагов не было видно на мини-карте'],
          tips: ['Без обзора держитесь своей половины карты.', 'Применяйте BKB в начале драки, ТП — чтобы уйти.'],
          footer: 'Не выкупайтесь: возрождение через 18 с.',
          stats: [],
          aiText: 'Вы зашли в чужой лес, когда трое врагов пропали с карты, и BKB остался неиспользованным.',
        },
      },
      { ...base, seq: 102, zone: 'timing', priority: 'info', category: 'timing', title: 'Руна силы через 15 с', text: t('Руна силы через 15 с (24:00).', 'Руна силы через 15 с (24:00). · Руна силы: 24:00 (база, не проверено)') },
    ];
  if (scene === 'match')
    return [
      {
        ...base,
        seq: 201,
        zone: 'review',
        priority: 'advice',
        category: 'review',
        title: 'Победа: разбор матча',
        text: '',
        ttlMs: 0,
        review: {
          kind: 'match',
          heading: 'Победа · 38:12 · Anti-Mage',
          why: ['Победа', 'Главная ошибка: простой'],
          tips: ['Не стоять без дела: волна, лагерь, стак', 'Успевать ключевой предмет к времени профи патча ±5 мин'],
          footer: null,
          stats: [
            { label: 'Добивания к 10:00', value: '52', ref: '59', verdict: 'ok' },
            { label: 'GPM', value: '702', ref: '664', verdict: 'good' },
            { label: 'XPM', value: '815', ref: '912', verdict: 'ok' },
            { label: 'Смерти', value: '4', ref: null, verdict: 'good' },
            { label: 'Battle Fury, мин', value: '16.2', ref: '13.7', verdict: 'bad' },
          ],
          aiText: null,
        },
      },
    ];
  return [
    { ...base, seq: 1, zone: 'alert', priority: 'critical', category: 'danger', title: '3 врага пропали — назад', text: t('3 врагов нет на мини-карте, а вы на их стороне карты — отойдите к своим башням.', '3 врагов нет на мини-карте, а вы на их стороне карты — отойдите к своим башням. · Врагов не видно: 3 (вывод, 0 с)') },
    {
      ...base,
      seq: 2,
      zone: 'decision',
      priority: 'advice',
      category: 'fight',
      title: 'Не вступать: шанс 31%',
      text: t('Не вступать: шанс 31%. 3 врага рядом.', 'Не вступать: шанс 31%. 3 врага рядом. Почему: союзники и враги рядом −24%, ульта −9%; неизвестно: ценность героев'),
      percent: {
        label: 'Шанс в драке',
        value: 31,
        confidence: 0.78,
        factors: detail === 'detailed' ? [
          { label: 'Союзники и враги рядом', effect: -24 },
          { label: 'Ульта', effect: -9 },
          { label: 'Здоровье', effect: 6 },
          { label: 'Матчап (статистика патча)', effect: 2 },
        ] : [],
      },
    },
    { ...base, seq: 3, zone: 'decision', priority: 'info', category: 'macro', source: 'ai', title: 'Фармить: лес Сил Света', text: t('Заберите лагеря своего леса — враги собрались на верхней линии.', 'Заберите лагеря своего леса — враги собрались на верхней линии. · Оценка коуча: фармить 55%, пушить 15%, отходить 22%, драться 8%') },
    { ...base, seq: 4, zone: 'timing', priority: 'info', category: 'timing', title: 'Руна силы через 15 с', text: t('Руна силы через 15 с (12:00).', 'Руна силы через 15 с (12:00). · Руна силы: 12:00 (база, не проверено)') },
    { ...base, seq: 5, zone: 'timing', priority: 'advice', category: 'economy', title: 'Золото 2400: купите Black King Bar', text: t('2400 золота лежит без дела. Следующий предмет по сборке профи патча — Black King Bar.', '2400 золота лежит без дела. Следующий предмет по сборке профи патча — Black King Bar. · Цена: 4050 (база, не проверено)') },
  ];
}

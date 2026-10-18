// Как играют сильные игроки в рейтинге (этап 3 «понимания игры»): STRATZ heroStats по рангам Divine–Immortal за
// последнюю неделю — по каждому герою и позиции 1–5:
//  - кривые по минутам: средние добивания, ценность героя (networth), опыт, уровень (heroStats.stats, groupByTime);
//  - покупки предметов: доля матчей, медианная минута, доля побед (heroStats.itemFullPurchase, по позиции отдельно).
// Запрос и преобразование — общие с приложением (src/core/knowledge-base/stratz-ranked.ts; Node 24 запускает .ts сам).
// Только рейтинговые матчи: у сводной статистики STRATZ нет фильтра по режиму, Турбо здесь нет (проверено 2026-10-18).
// Токен STRATZ — личный ключ владельца: читается из %USERPROFILE%\.stratz-token(.txt) или STRATZ_TOKEN, никуда не
// пишется и не печатается. ~130 запросов за запуск (лимиты: 8/с, 150/мин, 1 500/ч).
//   node scripts/import-stratz.mjs
// Результат: resources/data/kb/<патч>/stats-ranked.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stratzRankedQuery, toRankedHero, STRATZ_BRACKET } from '../src/core/knowledge-base/stratz-ranked.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const tokenFile = ['.stratz-token', '.stratz-token.txt'].map((f) => join(home, f)).find((f) => existsSync(f));
const token = (process.env.STRATZ_TOKEN ?? (tokenFile ? readFileSync(tokenFile, 'utf8') : '')).replace(/^﻿/, '').trim();
if (!token) {
  console.error('Нет токена STRATZ: положите его в %USERPROFILE%\\.stratz-token.txt (одна строка) или в STRATZ_TOKEN.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(query) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.stratz.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (res.ok) {
      const j = JSON.parse(text);
      if (j.errors?.length) throw new Error(`STRATZ: ${j.errors[0].message}`.replaceAll(token, '<token>'));
      return j.data;
    }
    // 429 — лимит: ждём и повторяем; остальное — до 4 попыток
    if (attempt >= 4) throw new Error(`STRATZ HTTP ${res.status}: ${text.slice(0, 200)}`.replaceAll(token, '<token>'));
    await sleep(res.status === 429 ? 30_000 : 3000 * attempt);
  }
}

const { patch } = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8'));
const kbDir = join(root, 'resources/data/kb', patch);
const heroes = JSON.parse(readFileSync(join(kbDir, 'heroes.json'), 'utf8'));
const items = JSON.parse(readFileSync(join(kbDir, 'items.json'), 'utf8'));
const itemKeyById = new Map(items.map((i) => [i.id, i.key]));

// Патч STRATZ должен совпадать с базой знаний — иначе данные другого баланса
const versions = (await gql('{ constants { gameVersions { id name } } }')).constants.gameVersions;
if (versions[0]?.name !== patch) {
  console.error(`Последний патч STRATZ — ${versions[0]?.name}, а база знаний — ${patch}. Сначала npm run kb:import.`);
  process.exit(1);
}

const out = [];
let calls = 1;
for (const h of heroes) {
  try {
    const d = (await gql(stratzRankedQuery(h.id))).heroStats;
    calls++;
    out.push(toRankedHero({ id: h.id, key: h.key }, d, itemKeyById));
  } catch (e) {
    console.warn(`${h.key}: ${e.message}`);
  }
  if (out.length % 20 === 0) console.log(`  героев: ${out.length}`);
  await sleep(450);
}

const file = {
  schema: 'dota-coach.stats-ranked',
  version: 1,
  patch,
  bracket: STRATZ_BRACKET,
  generatedAt: new Date().toISOString(),
  verification: 'imported-unverified',
  note: 'Рейтинговые матчи рангов Divine–Immortal за последнюю неделю (STRATZ heroStats). Кривые — средние значения по минутам: [добивания, ценность героя, опыт, уровень]. Покупки — по каждой позиции отдельно. Турбо здесь нет.',
  source: { name: 'STRATZ heroStats.stats / itemFullPurchase (по позициям)', calls },
  heroes: out,
};
writeFileSync(join(kbDir, 'stats-ranked.json'), JSON.stringify(file));
console.log(`Готово: героев ${out.length}, запросов ${calls} → ${join(kbDir, 'stats-ranked.json')}`);

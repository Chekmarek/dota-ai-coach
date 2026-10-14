# Контекст для ИИ-тренера

`src/core/ai/context.ts` → `buildAiContext(state, mechanics)` собирает компактный JSON-снимок того, что коуч знает
о матче. Он не зависит от будущей модели и **никакую модель не вызывает**: это вход, который ей потом передадут.

Схема стабильна: `schema: "dota-coach.ai-context"`, `version: 1`. Несовместимое изменение (удаление или
переименование поля, смена смысла) — только с повышением `version`; новые поля можно добавлять без него.

## Главное правило: неизвестное — явно

Каждое значение — `Fact<T>`, одно из двух:

```jsonc
// известно
{ "value": 12, "confidence": 0.93, "ageSec": 0.4, "tag": "visible", "source": "gsi" }
// неизвестно
{ "value": null, "reason": "never-observed" }
```

- `confidence` — 0…1; `ageSec` — секунд с последнего подтверждения.
- `tag`: `visible` — видно сейчас, `remembered` — видели раньше (значение может устареть), `inferred` — вывод
  (часы между чтениями; значок на мини-карте, когда рядом иллюзии).
- `source`: `gsi` — данные из игры (Valve Game State Integration), `screen` — с экрана (зрение).

Причины `reason`:

| Причина | Значит |
|---|---|
| `never-observed` | ни разу не видели — ни из игры, ни с экрана |
| `expired` | видели, но срок памяти значения истёк |
| `not-applicable` | к случаю не относится: время возрождения у живого |
| `hero-not-identified` | свой герой ещё не определён |
| `not-linked` | чья полоска здоровья — не известно наверняка (или её не видно) |
| `team-unknown` | своя команда неизвестна (нет данных из игры) |
| `clock-unknown` | игровое время неизвестно — таймеры не посчитать |
| `no-knowledge-base` | в базе знаний нет механики карты |

Значения по умолчанию не подставляются никогда: нет данных — `null` и причина.

## Поля

```jsonc
{
  "schema": "dota-coach.ai-context",
  "version": 1,
  "wallMs": 1739000000000,                 // момент снимка (часы движка, мс)
  "sources": { "gsi": true, "screen": true },
  "match": {
    "clockSec": Fact<number>,              // игровое время, с (до горна < 0)
    "paused": false,
    "dayNight": Fact<"day" | "night">,
    "scoreRadiant": Fact<number>,
    "scoreDire": Fact<number>
  },
  "myHero": {                              // свой герой: из игры, при её отсутствии — с экрана
    "hero": Fact<{ "id": number, "name": string }>,
    "level": Fact<number>,
    "health": Fact<{ "current": number, "max": number }>,
    "mana": Fact<{ "current": number, "max": number }>,
    "gold": Fact<number>,
    "kda": Fact<{ "kills": number, "deaths": number, "assists": number }>
  },
  "myTeam": { "value": "radiant", "source": "gsi" },   // или { "value": null, "reason": "team-unknown" }
  "players": [                             // 10 игроков по ячейкам верхней панели; [] — панель ещё не читалась
    {
      "slot": 7,                           // 0–4 Силы Света, 5–9 Силы Тьмы (= номер игрока в GSI)
      "team": "dire",
      "side": "enemy",                     // "ally" | "enemy" | null (своя команда неизвестна)
      "hero": Fact<string>,                // ключ героя, например "nevermore"
      "alive": Fact<boolean>,
      "respawnAtSec": Fact<number>,        // игровое время возрождения; у живого — not-applicable
      "position": Fact<{ "x": number, "y": number, "zone": MapZone }>,
      "missing": true,                     // враг пропал с мини-карты ≥ 3 с; null — не определить
      "missingForSec": 12,
      "hpPercent": Fact<number>            // с полоски над героем, только при несомненной привязке
    }
  ],
  "timers": {                              // или { "value": null, "reason": "no-knowledge-base" | "clock-unknown" }
    "upcoming": [
      { "id": "rune-power", "nameRu": "Руна силы", "atSec": 360, "inSec": 42, "verification": "verified" }
    ]
  }
}
```

`MapZone` — приблизительная область карты по координатам (`src/core/match-state/map-zones.ts`):
`radiant-base`, `dire-base`, `top-lane`, `bot-lane`, `mid-lane`, `river`, `radiant-jungle`, `dire-jungle`.
Это подпись по форме карты, а не данные Valve. `verification` таймера — насколько проверено значение
в базе знаний (`verified`, `imported-unverified`, `missing` — тогда `atSec`/`inSec` равны `null`).

## Откуда что

- Свой герой, время, счёт — данные из игры; без них — зрение нижней панели и часов.
- Герои, жизнь и возрождение игроков — верхняя панель (этап 1 зрения), места и «пропал» — мини-карта (этап 2),
  здоровье — полоски над героями (этап 3; к игроку привязывается только своя полоска по уровню из игры).
- Таймеры — `mechanics.json` базы знаний и игровое время.

Проверка схемы — `tests/unit/ai-context.test.ts`.

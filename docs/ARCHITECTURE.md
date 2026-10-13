# Dota AI Coach — Этап A: Архитектура

> Этап D выполнен (0.8.0, 2026-10-13): модель состояния матча `src/core/match-state/` (Tracked<T> с метками и TTL, события) подключена к движку и странице «Состояние матча».
> Статус: **согласовано** (2026-10-11). Этап B выполнен; этап C — числа HUD; база знаний (часть E) импортирована.
> Решение по OCR (этап C): для чисел HUD — собственный распознаватель по шаблонам символов (src/core/ocr/glyph-ocr.ts) вместо Tesseract: шрифт HUD фиксирован, точность выше, скорость ~10 мс/кадр, без WASM. Tesseract остаётся вариантом для свободного текста. OpenCV пока не подключён — понадобится для сопоставления иконок (герой, предметы).
> Уточнения при реализации B: в `src/main` добавлены `media\` (схема `dcmedia://` — единственный доступ окон к файлам) и `ipc\`; SQLite (`storage\`) появится на этапе H, пока настройки — JSON.
> Всё, что ниже помечено «проверить на этапе X», — гипотеза, а не подтверждённый факт.

---

## 0. Где лежит проект и как он раздаётся

| Что | Где | Почему |
|---|---|---|
| Исходники | `D:\DotaCoach\` | Латинский путь (часть нативных/WASM-инструментов ломается на кириллице), не в OneDrive (папка `node_modules` — десятки тысяч файлов, OneDrive будет бесконечно их синхронизировать), диск D — для больших файлов. |
| Готовые сборки | `D:\DotaCoach\release\` | `DotaCoach-Setup-x.y.z.exe` (установщик NSIS) и `DotaCoach-x.y.z-win-x64.zip` (портативная версия). |
| Данные пользователя | `%APPDATA%\DotaCoach\` (у установленной) или `.\data\` рядом с exe (у портативной) | Настройки, SQLite-база истории, раскладки HUD. |

Оба варианта собирает **electron-builder** одной командой `npm run dist`. Пользователю не нужен Node.js — всё упаковано внутри.
Ограничение: без платной подписи кода Windows SmartScreen покажет «Неизвестный издатель» → «Подробнее → Выполнить в любом случае». Это описывается в README.

---

## 1. Проверка библиотек (на 2026-10-11)

| Задача | Выбор | Версия (npm) | Почему именно это |
|---|---|---|---|
| Оболочка | Electron | 44.x (Node 24.21, Chromium 152) | По ТЗ. Закрепим патч-версию не моложе 2 недель (44.7.0 вышла 07.10 — возьмём предыдущий стабильный патч). |
| Сборка | electron-vite 5 + Vite | 5.0.0 | Один конфиг для main / preload / renderer, быстрая пересборка. |
| Упаковка | electron-builder | 26.x | NSIS-установщик + zip из одного конфига. |
| UI | React 19 + TypeScript | 19.3 / TS 5.x\* | По ТЗ. \*TS 7 (новый компилятор на Go) только что вышел — начнём на последнем 5.x, переход отдельно. |
| Захват | **Встроенный `desktopCapturer` Electron** + `getUserMedia` | — | Стандартный API захвата окна/экрана (Windows Graphics Capture под капотом). Ничего нативного ставить не нужно, процесс игры не трогаем. |
| Компьютерное зрение | **opencv.js** (`@techstark/opencv-js`) — WASM | 5.0.0 | Работает в Web Worker, не требует компиляции C++ под Electron → установщик не сломается на чужом ПК. Нативный `opencv4nodejs` отвергнут: тяжёлая сборка, плохая поддержка новых Node. |
| OCR | **tesseract.js** — WASM, локально | 7.0.0 | Полностью офлайн; языковые данные (`eng`, цифры) кладём в сборку, из интернета ничего не качается. |
| Валидация | zod | 4.x | Проверка всех IPC-сообщений, настроек и файлов базы знаний. |
| БД | **`node:sqlite`** (встроен в Node 24) | — | Без нативной сборки. Запасной вариант — `better-sqlite3` 13 (нужна пересборка под Electron). *Проверить на этапе B, что `node:sqlite` доступен в main-процессе Electron 44.* |
| TTS | Интерфейс `TtsEngine`; первая реализация — **Web Speech API** (`speechSynthesis`) | — | На Windows использует установленные системные голоса (в т.ч. русские), офлайн. Позже можно подключить Piper (уже знаком по проекту Птичкинс). *Проверить на этапе G список голосов в Electron.* |
| Тесты | Vitest 5, Playwright 1.6x (`_electron.launch`) | — | По ТЗ. |

---

## 2. Процессы и потоки данных

Главная идея: **кадры не путешествуют по IPC**. Они обрабатываются там же, где захвачены, наружу уходят только маленькие структуры.

```
┌──────────────────────── main process (Node) ────────────────────────┐
│ lifecycle · settings · SQLite (история, KB) · policy-gate · IPC     │
└───────────▲───────────────────────────────▲─────────────────────────┘
            │ MessagePort (команды,          │ ipc invoke (настройки,
            │ рекомендации для истории)      │ история, KB)
┌───────────┴──────── engine window ────────┐   ┌────── UI window ──────┐
│ (скрытое окно, без UI, sandbox)           │   │ React: Dashboard,     │
│ FrameSource ─► Worker: vision + OCR       │──►│ Diagnostics, ...      │
│                 └► game-state             │MP │ ≤4 Гц снимки состояния│
│                     └► decision/recommend │   │ ≤1 Гц превью-кадр     │
│                         └► voice (TTS)    │   └───────────────────────┘
└───────────────────────────────────────────┘   ┌── subtitles overlay ──┐
                                                │ только replay-режим   │
                                                └───────────────────────┘
```

Почему отдельное скрытое «engine window», а не всё в main:
- захват (`getUserMedia`), `OffscreenCanvas`, WASM-воркеры и `speechSynthesis` существуют только в renderer-контексте;
- кадр остаётся в памяти того же процесса → нет копирования мегабайт через IPC;
- если зрение упадёт или зависнет, main и UI продолжат работать, движок перезапустится.

Ядро (`core/*`) — **чистый TypeScript без Electron и DOM**. Поэтому его можно гонять в Vitest напрямую, а математику — вообще отдельно от зрения.

---

## 3. Дерево файлов

Отличия от ТЗ (с причинами): добавлены `src/engine/` (то самое скрытое окно, см. §2) и `src/preload/` (обязателен для contextIsolation); `capture/` перенесён из main в engine, потому что захват физически идёт в renderer-контексте; `policy/` выделен из `permissions/`, чтобы правило «ranked выключен» было в одном проверяемом месте.

```
D:\DotaCoach\
├─ package.json · electron.vite.config.ts · electron-builder.yml · tsconfig*.json
├─ docs\            ARCHITECTURE.md · LIMITATIONS.md · POLICY.md · DATA_SOURCES.md
├─ resources\       иконка, tessdata\eng.traineddata, шаблоны HUD
├─ scripts\         import-kb.ts (импорт базы знаний), make-fixture.ts
├─ src\
│  ├─ main\
│  │  ├─ application\   создание окон, меню, single-instance
│  │  ├─ lifecycle\     старт/стоп движка, перезапуск при сбое
│  │  ├─ ipc\           реестр каналов + zod-валидация
│  │  ├─ policy\        PolicyGate: какие режимы разрешены
│  │  ├─ storage\       SQLite: история рекомендаций, сессии, метрики
│  │  └─ settings\      чтение/запись настроек по схеме
│  ├─ preload\          ui.ts, engine.ts — узкие API через contextBridge
│  ├─ engine\           точка входа скрытого окна, оркестратор конвейера
│  │  ├─ capture\       FrameSource: DesktopSource, VideoFileSource, ImageFolderSource
│  │  └─ workers\       vision.worker.ts
│  ├─ renderer\
│  │  ├─ pages\         Dashboard, LiveGame, ReplayMode, MatchState, History,
│  │  │                 KnowledgeBase, VoiceSettings, Updates, AppSettings
│  │  ├─ components\    общие компоненты (ConfidenceBadge, StaleMarker, ...)
│  │  ├─ overlay\       окно субтитров
│  │  └─ settings\      формы настроек
│  ├─ core\             ← чистый TS, без Electron
│  │  ├─ vision\        регионы HUD, препроцессинг, template matching
│  │  ├─ ocr\           обёртка OCR-движка (интерфейс + tesseract-реализация)
│  │  ├─ game-state\    MatchState, слияние наблюдений, устаревание
│  │  ├─ confidence\    правила агрегации уверенности
│  │  ├─ knowledge-base\загрузка и проверка версионированных данных
│  │  ├─ math-engine\   exact\ (формулы игры) и heuristic\ (оценки) — раздельно
│  │  ├─ decision-engine\ стратегии: purchase, skill-build, positioning, team
│  │  ├─ recommendation\ отбор, приоритеты, дедупликация, отзыв
│  │  └─ voice\         TtsEngine, очередь, фразы short/long
│  ├─ shared\           types\ · events\ · schemas\ (zod)
│  └─ data\             heroes\ · items\ · patches\ · hud-layouts\  (JSON по патчам)
├─ tests\
│  ├─ unit\ · integration\ · e2e\
│  └─ fixtures\         frames\*.png + *.truth.json, clips\*.mp4 + *.truth.json
└─ release\             готовые установщик и zip (не в git)
```

---

## 4. Ключевые типы данных

```ts
// ---------- Наблюдение: любое значение, полученное с экрана ----------
type Validity = 'valid' | 'stale' | 'conflicting' | 'out-of-range';

interface Observed<T> {
  value: T | null;          // null = не распознано. Никаких «придуманных» значений
  confidence: number;       // 0..1
  observedAt: number;       // время кадра, мс (время записи, а не время обработки)
  sourceRegion: RegionRef;  // какая область HUD, в какой раскладке
  validity: Validity;
  schemaVersion: string;    // версия раскладки HUD / схемы
  patch?: string;           // если значение зависит от патча
}

interface RegionRef { layoutId: string; regionId: string; rect: Rect; frameSize: Size }

// ---------- Поле состояния матча: явно разделяем 4 вида знания ----------
type Field<T> =
  | { kind: 'observed';   obs: Observed<T> }                          // видно сейчас
  | { kind: 'remembered'; obs: Observed<T>; ageMs: number }           // видели раньше
  | { kind: 'inferred';   value: T; confidence: number;
                          basis: string[]; ruleId: string }            // вывод/догадка
  | { kind: 'unknown';    reason: UnknownReason };

type UnknownReason = 'not-visible' | 'not-recognized' | 'expired' | 'menu-open' | 'not-implemented';

// ---------- Состояние матча ----------
interface MatchState {
  frameTime: number;
  patch: string | null;
  gameClock: Field<number>;              // секунды игрового времени
  player: {
    hero: Field<HeroId>;
    level: Field<number>;
    hp: Field<{ current: number; max: number }>;
    mana: Field<{ current: number; max: number }>;
    gold: Field<number>;
    abilities: Field<AbilitySlotState>[];
    inventory: Field<ItemId | 'empty'>[];   // 6 слотов + рюкзак + нейтралка
  };
  visibleEnemies: Field<VisibleHero[]>;  // только видимые! Невидимый ≠ отсутствующий
  enemyLastSeen: Record<HeroId, { at: number; where: MapZone | null }>;
  openMenus: Field<MenuKind[]>;          // магазин/скорборд → часть HUD перекрыта
}

// ---------- Рекомендация ----------
type Priority = 1 | 2 | 3 | 4;   // 1 срочно · 2 тактика · 3 предметы/способности · 4 стратегия

interface Recommendation {
  id: string;
  dedupeKey: string;            // одинаковый смысл → одинаковый ключ
  strategy: 'purchase' | 'skill-build' | 'positioning' | 'team';
  priority: Priority;
  action: string;               // «Купить Magic Wand»
  rationale: string;            // почему
  factsUsed: FactRef[];         // ссылки на конкретные Observed/KB-записи
  confidence: number;
  exactness: 'exact-formula' | 'heuristic';
  invalidWhen: InvalidationRule[];   // например gold < 450, предмет уже куплен, прошло 30 с
  createdAt: number;
  expiresAt: number;
  speech: { short: string; long?: string };
}

// ---------- Источник кадров ----------
interface FrameSource {
  readonly kind: 'desktop' | 'video-file' | 'image-folder';
  start(opts: { fps: number; maxWidth: number }): Promise<void>;
  stop(): Promise<void>;              // обязательно освобождает треки/декодер
  onFrame(cb: (f: Frame) => void): Unsubscribe;
  onError(cb: (e: CaptureError) => void): Unsubscribe;
}

// ---------- Голос ----------
interface TtsEngine {
  listVoices(): Promise<VoiceInfo[]>;
  speak(text: string, o: { voiceId: string; rate: number; volume: number }): SpeechHandle;
}
```

База знаний — каждая запись несёт источник и статус проверки:

```ts
interface KbRecord<T> {
  data: T;
  patch: string;                  // '7.39c' и т.п.
  source: { name: string; url?: string; retrievedAt: string };
  verification: 'verified' | 'imported-unverified' | 'missing';
}
// Математика с флагом exact отказывается работать с 'imported-unverified' → рекомендация отбрасывается.
```

---

## 5. Безопасность и политика использования

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` во всех окнах; CSP без `unsafe-eval` (WASM — через `wasm-unsafe-eval`).
- Preload отдаёт только именованные функции; каждый IPC-канал имеет zod-схему, неизвестные каналы отклоняются.
- `will-navigate` / `setWindowOpenHandler` запрещают открытие внешних страниц; ссылки — только через `shell.openExternal` по белому списку.
- Ничего не скачивается и не исполняется во время работы. База знаний собирается скриптом при разработке и едет внутри сборки.
- **Нет никакого ввода в игру**: в коде нет библиотек эмуляции клавиатуры/мыши, это проверяет тест-«сторож» по зависимостям.
- **PolicyGate** — режимы:
  - `replay` — записанные кадры/видео. **Единственный включённый в v1.**
  - `live-observe` — живой захват без подсказок (только диагностика зрения). Выключен до этапа J.
  - `live-coach-unranked` / `live-coach-ranked` — выключены, переключателей в UI нет. Включаются только после документированного решения в `POLICY.md`.

---

## 6. План тестирования

| Уровень | Что проверяем | Чем |
|---|---|---|
| Unit | формулы (известные входы → известные выходы), слияние наблюдений, устаревание, дедуп и отзыв рекомендаций, очередь TTS | Vitest |
| Vision-регрессия | кадры `fixtures/frames/*.png` с ручной разметкой `*.truth.json` → точность по каждому полю, доля ложных значений | Vitest + отчёт |
| Integration | видео → полный конвейер → поток рекомендаций; задержка кадр→рекомендация | Vitest (core) + Playwright |
| E2E | приложение запускается, экраны открываются, replay проигрывается, ranked-режим недоступен | Playwright `_electron` |
| Сборка | установщик ставится/удаляется, zip запускается на чистом пользователе | ручной чек-лист + скрипт |

Главная метрика зрения — **не точность, а отсутствие уверенных ошибок**: лучше `unknown`, чем неверное число с confidence 0.9.

---

## 7. Этапы и критерии готовности

| Этап | Готово, когда… |
|---|---|
| **A** Architecture | этот документ согласован. |
| **B** Desktop Shell | `npm run dev` открывает тёмное окно с 8 пустыми экранами (каждый честно пишет «не реализовано»); настройки сохраняются и переживают перезапуск; ImageFolderSource/VideoFileSource показывают кадры в Replay Mode с заданным FPS; `npm run dist` выдаёт рабочие установщик и zip; e2e-тест запуска зелёный. |
| **C** Vision | раскладка HUD задаётся в JSON и масштабируется под разрешение; на размеченных кадрах время/золото/уровень распознаются ≥ 95 %, а уверенных ошибок (conf ≥ 0.8 и неверно) < 1 %; Vision Diagnostics показывает рамки регионов, OCR-текст и confidence. |
| **D** Game State | все поля — `Field<T>`; устаревание по настраиваемым TTL; невидимый враг никогда не становится «отсутствующим»; unit-тесты на слияние и сброс. |
| **E** Math Engine | exact и heuristic разделены по папкам; формулы (броня, атрибуты, стоимость сборки предмета, «хватает ли золота») покрыты тестами с эталонными значениями из источника, указанного в `DATA_SOURCES.md`; неподтверждённые данные блокируют exact-расчёт. |
| **F** Recommendations | 4 стратегии с отдельной оценкой; приоритеты 1–4; дубль не повторяется в окне N секунд; рекомендация отзывается при срабатывании `invalidWhen`; при низкой уверенности входа — либо отбрасывается, либо формулируется как «возможно». |
| **G** Voice | очередь с приоритетами; срочное прерывает фоновое; устаревшее не озвучивается; громкость/скорость/голос/выкл работают; голос озвучивает только `speech` из рекомендации. |
| **H** Integration | записанный матч проигрывается целиком без падений; история пишется в SQLite. |
| **I** Validation | отчёт: точность по полям, задержка (p50/p95), CPU/GPU/ОЗУ, работа 60+ минут без утечек. |
| **J** Policy Review | `POLICY.md`: способ захвата, все источники данных, ссылки на актуальные правила Valve и решение по каждому live-режиму. |

---

## 8. Известные риски и ограничения (заранее)

1. **Правила Valve.** Valve уже запрещала сторонние оверлеи, дающие подсказки во время матча. Поэтому live-подсказки выключены по умолчанию, а решение принимается только после этапа J.
2. **Иконки героев и предметов** принадлежат Valve. Распространять их внутри установщика может быть нельзя. Вариант: шаблоны для template matching пользователь создаёт сам из своих скриншотов прямо в приложении (инструмент на этапе C).
3. **Разные интерфейсы.** Разрешение, размер HUD, язык клиента и полупрозрачность панели меняют картинку. Начнём с одной раскладки (1920×1080, стандартный HUD) и сделаем раскладки расширяемыми.
4. **Источник данных о героях и предметах.** План: скрипт импорта из открытого набора (например, dotaconstants, лицензия MIT — *проверить*), все записи приходят как `imported-unverified` и подтверждаются вручную по патч-ноутам.
5. **Подписи кода нет** → предупреждение SmartScreen при установке.
6. **Мы пока не говорим «анализ в реальном времени»**: это заявление появится только после замеров на этапе I.

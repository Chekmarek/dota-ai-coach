// Значок поверх игры: появление, смена состояний, уход и редкие вспышки.
// Перенесено из обновления 0.7.0 (out/renderer/overlay/overlay.js), логика не менялась.
// Анимации — CSS (transform и opacity). Случайные события — цепочками setTimeout,
// не чаще раза в несколько секунд; вне состояния «видит игру» таймеров моргания и вспышек нет.
import type { LiveState } from '@shared/types/capture';
import type { OverlayCorner } from '@shared/schemas/settings';

interface OverlayState {
  state: LiveState;
  fps: number;
  corner?: OverlayCorner;
}

declare global {
  interface Window {
    dotacoachOverlay?: { onState(fn: (s: OverlayState) => void): void };
  }
}

type Shown = 'seeing' | 'no-image';
type Timer = ReturnType<typeof setTimeout> | null;

const TEXT: Record<LiveState, string> = { seeing: 'видит игру', 'no-image': 'нет картинки', 'waiting-dota': 'ждёт Доту', off: 'выключен' };
const VISIBLE: LiveState[] = ['seeing', 'no-image'];
const CALM_AFTER_MS = 6e3;
const BLINK_MS = [7e3, 15e3] as const;
const FLOURISH_MS = [45e3, 9e4] as const;
const EYE = { x: 20.5, y: 23 }; // центр ока внутри значка, px
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id: string) => document.getElementById(id)!;
const badge = $('badge');
const statusEl = $('status');
const eye = $('eye');
const fx = $('fx');

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

let current: Shown | null = null; // показанное состояние; null — значок скрыт или уходит
let foldedAt = 0;
let calmTimer: Timer = null;
let blinkTimer: Timer = null;
let flourishTimer: Timer = null;
let flourishBusy = false;
let eyeTimer: Timer = null;

/** Перезапускает CSS-анимацию класса: снимает класс, сбрасывает стиль, ставит снова */
function restart(el: Element, cls: string): void {
  el.classList.remove(cls);
  void el.getBoundingClientRect();
  el.classList.add(cls);
}

/** Одноразовая частица/кольцо в центре ока; удаляется сама через ms */
function spawn(cls: string, styles: Record<string, string>, ms: number): void {
  const el = document.createElement('i');
  el.className = cls;
  el.style.left = `${EYE.x}px`;
  el.style.top = `${EYE.y}px`;
  for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v);
  fx.appendChild(el);
  later(ms, () => el.remove());
}

function burst(): void {
  const n = 7 + Math.floor(Math.random() * 2);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rnd(-0.25, 0.25);
    const r = rnd(12, 18);
    spawn(
      'spark',
      {
        '--dx': `${(Math.cos(a) * r).toFixed(1)}px`,
        '--dy': `${(Math.sin(a) * r).toFixed(1)}px`,
        '--d': `${rnd(0.3, 0.4).toFixed(2)}s`,
      },
      1400,
    );
  }
}

function embers(): void {
  const n = 3 + Math.floor(Math.random() * 3);
  for (let k = 0; k < n; k++) {
    spawn(
      'ember',
      {
        '--dx': `${rnd(-8, 8).toFixed(1)}px`,
        '--dy': `${rnd(-21, -15).toFixed(1)}px`,
        '--d': `${rnd(0, 0.25).toFixed(2)}s`,
      },
      1500,
    );
  }
}

function playEye(cls: string, ms: number): void {
  if (eyeTimer) clearTimeout(eyeTimer);
  eye.classList.remove('blink', 'blink2', 'eye-open');
  void eye.getBoundingClientRect();
  eye.classList.add(cls);
  eyeTimer = later(ms, () => eye.classList.remove(cls));
}

function setStateClass(s: Shown | null): void {
  badge.classList.remove('seeing', 'no-image');
  if (s) badge.classList.add(s);
}

// Моргание: одиночное или двойное, случайно раз в 7–15 с, пока коуч видит игру
function scheduleBlink(): void {
  blinkTimer = later(rnd(BLINK_MS[0], BLINK_MS[1]), () => {
    if (current !== 'seeing') return;
    if (Math.random() < 0.25) playEye('blink2', 380);
    else playEye('blink', 170);
    scheduleBlink();
  });
}

// Редкие вспышки: одна за раз, раз в 45–90 с, только пока коуч видит игру
function scheduleFlourish(): void {
  flourishTimer = later(rnd(FLOURISH_MS[0], FLOURISH_MS[1]), () => {
    flourish();
    scheduleFlourish();
  });
}

function flourish(): void {
  if (current !== 'seeing' || flourishBusy) return;
  flourishBusy = true;
  // В режиме «уменьшить движение» остаётся только вспышка рун (через прозрачность)
  const kind = reduced ? 'runes' : pick(['runes', 'embers', 'sheen'] as const);
  let len = 1500;
  if (kind === 'runes') {
    restart(badge, 'lit');
    len = 1900;
    later(len, () => badge.classList.remove('lit'));
  } else if (kind === 'embers') {
    embers();
  } else {
    restart(badge, 'sweep-on');
    len = 1200;
    later(len, () => badge.classList.remove('sweep-on'));
  }
  later(len, () => {
    flourishBusy = false;
  });
}

function stopIdle(): void {
  for (const t of [calmTimer, blinkTimer, flourishTimer]) if (t) clearTimeout(t);
  calmTimer = blinkTimer = flourishTimer = null;
}

/** Спокойный режим и таймеры — только когда видно «видит игру» */
function syncIdle(): void {
  stopIdle();
  if (current !== 'seeing') return;
  // Спокойное состояние приглушаем, чтобы не отвлекать; проблемы остаются яркими
  calmTimer = later(CALM_AFTER_MS, () => badge.classList.add('calm'));
  if (!reduced) scheduleBlink();
  scheduleFlourish();
}

/** Появление: рамка разворачивается, кольцо оборачивается, искры, затем текст */
function summon(state: Shown): void {
  if (eyeTimer) clearTimeout(eyeTimer);
  badge.classList.remove('fold', 'calm');
  restart(badge, 'summon');
  setStateClass(state);
  statusEl.textContent = TEXT[state] ?? '';
  statusEl.classList.remove('swap');
  if (!reduced && Date.now() - foldedAt > 1e3) burst();
  current = state;
}

/** Уход: обратное появление без искр. Окно прячет main через 400 мс */
function fold(): void {
  if (current === null) return;
  current = null;
  foldedAt = Date.now();
  stopIdle();
  badge.classList.remove('calm', 'shake', 'lit', 'sweep-on');
  badge.classList.add('fold');
}

/** Смена состояния, когда значок уже на экране */
function change(to: Shown): void {
  current = to;
  setStateClass(to);
  badge.classList.remove('calm');
  statusEl.classList.add('swap');
  later(180, () => {
    statusEl.textContent = TEXT[to] ?? '';
    statusEl.classList.remove('swap');
  });
  if (to === 'no-image') {
    // Встряска и красная вспышка камня; око полуприкрыто и мерцает (CSS)
    if (!reduced) restart(badge, 'shake');
    spawn('flash', {}, 600);
  } else {
    // Восстановление: зелёное кольцо расходится от ока, око открывается
    spawn('ripple', {}, 800);
    playEye('eye-open', 420);
  }
  syncIdle();
}

function setState(s: OverlayState): void {
  document.body.className = s.corner ?? 'top-right';
  if (!VISIBLE.includes(s.state)) {
    fold();
    return;
  }
  const state = s.state as Shown;
  if (current === null) {
    summon(state);
    syncIdle();
    return;
  }
  if (state === current) return;
  change(state);
}

window.dotacoachOverlay?.onState(setState);

export {};

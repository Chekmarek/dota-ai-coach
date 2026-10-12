// Генерирует синтетические тестовые данные:
//  - tests/fixtures/frames/synthetic/*.png — 24 кадра 1280×720 (НЕ скриншоты Dota, только для проверки конвейера)
//  - resources/icon.png — иконка приложения 256×256
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function canvas(w, h, bg) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(bg, i * 4);
  return {
    px,
    rect(x, y, rw, rh, c) {
      for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++)
        for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) px.set(c, (j * w + i) * 4);
    },
    disc(cx, cy, r, c, inner = 0) {
      for (let j = Math.floor(cy - r); j <= cy + r; j++)
        for (let i = Math.floor(cx - r); i <= cx + r; i++) {
          const d = Math.hypot(i - cx, j - cy);
          if (d <= r && d >= inner && i >= 0 && j >= 0 && i < w && j < h) px.set(c, (j * w + i) * 4);
        }
    },
  };
}

// --- Кадры ---
const framesDir = join(root, 'tests/fixtures/frames/synthetic');
mkdirSync(framesDir, { recursive: true });
const W = 1280, H = 720, N = 24;
for (let n = 0; n < N; n++) {
  const c = canvas(W, H, [14, 18, 24, 255]);
  c.rect(0, H - 120, W, 120, [28, 34, 44, 255]); // «панель HUD»
  c.rect(40 + n * 48, 300, 60, 60, [229, 72, 59, 255]); // движущийся объект
  for (let b = 0; b < 5; b++) c.rect(40 + b * 30, H - 80, 22, 40, ((n >> b) & 1) ? [63, 185, 80, 255] : [60, 60, 60, 255]); // номер кадра в двоичном виде
  writeFileSync(join(framesDir, `frame_${String(n).padStart(3, '0')}.png`), encodePng(W, H, c.px));
}
writeFileSync(
  join(framesDir, 'README.txt'),
  'Синтетические кадры для проверки конвейера захвата. Это НЕ скриншоты Dota 2.\n' +
    'Номер кадра закодирован пятью квадратами внизу слева (зелёный = 1, младший бит слева).\n',
);

// --- Иконка ---
const I = 256;
const ic = canvas(I, I, [0, 0, 0, 0]);
ic.disc(128, 128, 120, [18, 24, 33, 255]);
ic.disc(128, 128, 112, [229, 72, 59, 255], 96);
// стилизованная «D»
ic.rect(84, 72, 22, 112, [255, 122, 89, 255]);
for (let j = 72; j < 184; j++)
  for (let i = 100; i < 180; i++) {
    const d = Math.hypot((i - 104) / 72, (j - 128) / 56);
    if (d <= 1 && d >= 0.7) ic.px.set([255, 122, 89, 255], (j * I + i) * 4);
  }
mkdirSync(join(root, 'resources'), { recursive: true });
writeFileSync(join(root, 'resources/icon.png'), encodePng(I, I, ic.px));

console.log(`Готово: ${N} кадров в ${framesDir}, иконка в resources/icon.png`);

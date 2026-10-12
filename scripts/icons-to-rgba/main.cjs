// Переводит скачанные иконки (часть — чересстрочные PNG) в простые RGBA-PNG, которые читает scripts/png.mjs.
//   node_modules\electron\dist\electron.exe scripts\icons-to-rgba\main.cjs <папка-иконок> <папка-результата>
// Декодирует встроенный в Electron nativeImage (Chromium), кодирует наш encodePng.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const [src, dst] = process.argv.slice(-2);
app.whenReady().then(async () => {
  const { encodePng } = await import(require('url').pathToFileURL(path.join(__dirname, '..', 'png.mjs')).href);
  let n = 0;
  for (const kind of fs.readdirSync(src)) {
    const dir = path.join(src, kind);
    if (!fs.statSync(dir).isDirectory()) continue;
    fs.mkdirSync(path.join(dst, kind), { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.png')) continue;
      const img = nativeImage.createFromPath(path.join(dir, f));
      if (img.isEmpty()) {
        console.log('ПУСТО', kind, f);
        continue;
      }
      const { width, height } = img.getSize();
      const bgra = img.toBitmap();
      const rgba = new Uint8Array(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) {
        rgba[i] = bgra[i + 2];
        rgba[i + 1] = bgra[i + 1];
        rgba[i + 2] = bgra[i];
        rgba[i + 3] = bgra[i + 3];
      }
      fs.writeFileSync(path.join(dst, kind, f), encodePng(width, height, rgba));
      n++;
    }
  }
  console.log('переведено иконок:', n);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

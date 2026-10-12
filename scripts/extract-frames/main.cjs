// Достаёт кадры из видео: node_modules\electron\dist\electron.exe main.cjs <video> <outDir> <t1,t2,...>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [video, outDir, times] = process.argv.slice(-3);
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
  await win.loadFile(path.join(__dirname, 'page.html'));
  const url = 'file:///' + video.replace(/\\/g, '/');
  const info = await win.webContents.executeJavaScript(`new Promise((res, rej) => {
    const v = document.getElementById('v'); v.src = ${JSON.stringify(url)};
    v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
    v.onerror = () => rej(new Error('video error ' + (v.error && v.error.code)));
  })`);
  console.log('INFO', JSON.stringify(info));
  for (const t of times.split(',').map(Number)) {
    const b64 = await win.webContents.executeJavaScript(`new Promise((res) => {
      const v = document.getElementById('v');
      v.onseeked = () => { const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0); res(c.toDataURL('image/png').split(',')[1]); };
      v.currentTime = ${t};
    })`);
    const f = path.join(outDir, `t${String(t).padStart(2, '0')}.png`);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    console.log('SAVED', f);
  }
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

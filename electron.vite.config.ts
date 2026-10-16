import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@core': resolve(__dirname, 'src/core'),
};

// Content-Security-Policy подставляется в HTML при сборке.
// В dev-режиме Vite нужен inline-скрипт (горячая перезагрузка React) и WebSocket,
// в готовой сборке их нет — политика строже.
function csp(): Plugin {
  return {
    name: 'dotacoach-csp',
    transformIndexHtml(html, ctx) {
      const dev = Boolean(ctx.server);
      const policy = [
        "default-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-inline'" : ''}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: dcmedia:",
        "font-src 'self'",
        "media-src 'self' blob: dcmedia:",
        `connect-src 'self' dcmedia:${dev ? ' ws: http://localhost:*' : ''}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      return html.replace('%CSP%', policy);
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          ui: resolve(__dirname, 'src/preload/ui.ts'),
          engine: resolve(__dirname, 'src/preload/engine.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          hud: resolve(__dirname, 'src/preload/hud.ts'),
        },
        // Sandbox-preload в Electron умеет только CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    resolve: { alias },
    plugins: [react(), csp()],
    build: {
      rollupOptions: {
        input: {
          ui: resolve(__dirname, 'src/renderer/index.html'),
          engine: resolve(__dirname, 'src/engine/index.html'),
          // значок «Коуч» поверх игры (живой режим)
          overlay: resolve(__dirname, 'src/overlay/index.html'),
          // подсказки поверх игры (этап 3)
          hud: resolve(__dirname, 'src/hud/index.html'),
        },
      },
    },
  },
});

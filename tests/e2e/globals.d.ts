import type { DotaCoachApi } from '../../src/shared/ipc';

// Код внутри page.evaluate() выполняется в окне интерфейса, где preload выдаёт window.dotacoach
declare global {
  interface Window {
    dotacoach: DotaCoachApi;
  }
}

export {};

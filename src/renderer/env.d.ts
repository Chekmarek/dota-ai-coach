import type { DotaCoachApi } from '@shared/ipc';

declare global {
  interface Window {
    dotacoach: DotaCoachApi;
  }
}

export {};

// ИИ-помощник в main: IPC интерфейса (проверка отправителя + zod), ключи в safeStorage, локальный llama-server.
// Вопросы, ответы и ключи в журнал не пишутся — только коды ошибок и состояние llama-server.
import { BrowserWindow, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '@shared/ipc';
import { aiAskPayloadSchema, aiFeedbackSchema, aiKeyPayloadSchema, type AiAskResult, type AiUiState } from '@shared/types/ai';
import { AI_LOCAL_MODELS } from '@shared/schemas/settings';
import { z } from 'zod';
import type { SettingsStore } from '../settings/store';
import { liveLog } from '../live/live';
import { AiService } from './service';
import { KeyStore } from './keys';
import { LocalInstaller } from './local/installer';
import { LlamaSidecar } from './local/sidecar';
import { MODELS } from './local/manifest';
import { listSessions, readSessionMatch } from './sessions';

interface Deps {
  settings: SettingsStore;
  dataDir: string;
  getUi: () => BrowserWindow | null;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  inMatch: () => boolean;
}

export interface AiHandle {
  dispose(): void;
}

export function setupAi(deps: Deps): AiHandle {
  const dir = join(deps.dataDir, 'ai');
  const keys = new KeyStore(dir, safeStorage);
  let tokensPerSec: number | null = null;
  let ramBytes: number | null = null;
  let downloadCtrl: AbortController | null = null;

  const installer = new LocalInstaller(deps.dataDir, () => push());
  const sidecar = new LlamaSidecar({
    exe: () => installer.serverExe(),
    modelPath: (m) => installer.modelPath(m),
    installed: (m) => installer.runtimeInstalled() && installer.modelInstalled(m),
    onState: () => {
      if (sidecar?.state.status !== 'ready') ramBytes = null;
      push();
    },
    log: liveLog,
  });
  const service = new AiService({
    getSettings: () => deps.settings.get(),
    keys,
    local: { ensure: (m, signal) => sidecar.ensure(m, signal), touch: () => sidecar.touch() },
    inMatch: deps.inMatch,
    log: liveLog,
  });

  function state(): AiUiState {
    const sc = sidecar.state;
    return {
      keys: { openaiCompatible: keys.has('openai-compatible') },
      encryption: safeStorage.isEncryptionAvailable(),
      busy: service.busy,
      inMatch: deps.inMatch(),
      local: {
        runtimeInstalled: installer.runtimeInstalled(),
        runtimeSizeBytes: installer.runtime.sizeBytes,
        models: AI_LOCAL_MODELS.map((id) => ({ id, nameRu: MODELS[id].nameRu, sizeBytes: MODELS[id].sizeBytes, installed: installer.modelInstalled(id) })),
        download: { ...installer.progress },
        server: { status: sc.status, model: sc.model, error: sc.error, loadMs: sc.loadMs, tokensPerSec, ramBytes, threads: sc.threads },
      },
    };
  }

  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  function push(): void {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const ui = deps.getUi();
      if (ui && !ui.isDestroyed()) ui.webContents.send(IPC.aiState, state());
    }, 200);
  }

  const handle = <T>(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => T | Promise<T>) => {
    ipcMain.handle(channel, (e, arg: unknown) => {
      if (!deps.isTrustedSender(e)) throw new Error('Untrusted IPC sender');
      return fn(e, arg);
    });
  };

  handle(IPC.aiGet, () => state());

  handle(IPC.aiAsk, async (e, arg): Promise<AiAskResult> => {
    const p = aiAskPayloadSchema.parse(arg);
    const sender = e.sender;
    push();
    const r = await service.ask(p, (text) => {
      if (!sender.isDestroyed()) sender.send(IPC.aiChunk, { requestId: p.requestId, text });
    });
    if (r.provider === 'local' && !r.error && r.chunks > 1 && r.firstChunkMs !== null) {
      const genMs = r.totalMs - r.firstChunkMs;
      if (genMs > 0) tokensPerSec = Math.round(((r.chunks - 1) / genMs) * 10_000) / 10;
      ramBytes = await sidecar.ramBytes();
    }
    push();
    return r;
  });

  handle(IPC.aiCancel, (_e, arg) => {
    service.cancel(z.string().max(64).optional().parse(arg));
  });

  handle(IPC.aiSetKey, (_e, arg) => {
    const p = aiKeyPayloadSchema.parse(arg);
    keys.set(p.provider, p.key.trim());
    liveLog('ai ключ облака сохранён');
    return state();
  });

  handle(IPC.aiClearKey, () => {
    keys.clear('openai-compatible');
    liveLog('ai ключ облака удалён');
    return state();
  });

  // «Полезно» / «Мимо» — только в локальный файл, никуда не отправляется
  handle(IPC.aiFeedback, (_e, arg) => {
    const f = aiFeedbackSchema.parse(arg);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'feedback.jsonl'), `${JSON.stringify({ t: Date.now(), ...f })}\n`, 'utf8');
  });

  handle(IPC.aiLocalDownload, async (_e, arg) => {
    const model = z.enum(AI_LOCAL_MODELS).parse(arg);
    if (downloadCtrl) return state();
    downloadCtrl = new AbortController();
    liveLog(`ai скачивание локального ИИ: ${model}`);
    try {
      await installer.install(model, downloadCtrl.signal);
      liveLog('ai локальный ИИ скачан и проверен');
    } catch (err) {
      liveLog(`ai скачивание не удалось: ${(err as Error).message}`);
    } finally {
      downloadCtrl = null;
    }
    return state();
  });

  handle(IPC.aiLocalCancel, () => {
    downloadCtrl?.abort();
    return state();
  });

  handle(IPC.aiLocalDelete, () => {
    downloadCtrl?.abort();
    sidecar.stop();
    // Windows отпускает файлы не мгновенно после остановки процесса
    for (let i = 0; i < 20; i++) {
      try {
        installer.removeAll();
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    liveLog('ai локальный ИИ удалён');
    return state();
  });

  handle(IPC.aiSessions, () => listSessions(deps.dataDir));
  handle(IPC.aiSessionReadings, (_e, arg) => readSessionMatch(deps.dataDir, z.string().max(40).parse(arg)));

  handle(IPC.aiLocalStop, () => {
    sidecar.stop();
    return state();
  });

  return {
    dispose: () => {
      downloadCtrl?.abort();
      service.cancel();
      sidecar.stop();
    },
  };
}

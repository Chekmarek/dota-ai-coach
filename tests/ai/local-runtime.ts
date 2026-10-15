// Настоящий локальный ИИ для npm run ai:bench / ai:eval: тот же установщик, llama-server и клиент, что в приложении.
// Папка данных: DOTACOACH_AI_DATA или .tmp/ai-local-data. Если файлы уже лежат в .tmp/ai-dl (скачаны заранее),
// они подкладываются как недокачанные (.part) — установщик проверит SHA-256 и не будет качать заново.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { LocalInstaller } from '../../src/main/ai/local/installer';
import { LlamaSidecar } from '../../src/main/ai/local/sidecar';
import { MODELS, RUNTIME } from '../../src/main/ai/local/manifest';
import { AiService } from '../../src/main/ai/service';
import { defaultSettings, type AiLocalModel, type Settings } from '../../src/shared/schemas/settings';

const ROOT = resolve(import.meta.dirname, '../..');

export function localModels(): AiLocalModel[] {
  const env = process.env.DOTACOACH_AI_MODELS;
  if (env === 'all') return ['qwen3-1.7b', 'qwen3-4b'];
  return env ? (env.split(',') as AiLocalModel[]) : ['qwen3-1.7b'];
}

export async function prepareLocal(model: AiLocalModel, inMatch = false) {
  const dataDir = process.env.DOTACOACH_AI_DATA ?? join(ROOT, '.tmp/ai-local-data');
  const aiDir = join(dataDir, 'ai');
  mkdirSync(aiDir, { recursive: true });
  const cache = join(ROOT, '.tmp/ai-dl');
  for (const f of [RUNTIME.fileName, MODELS[model].fileName]) {
    const src = join(cache, f);
    if (existsSync(src) && !existsSync(join(aiDir, f)) && !existsSync(join(aiDir, `${f}.part`))) copyFileSync(src, join(aiDir, `${f}.part`));
  }
  const installer = new LocalInstaller(dataDir, (p) => {
    if (p.status !== 'downloading') console.log(`[установка] ${p.status} ${p.file ?? ''}`);
  });
  await installer.install(model, new AbortController().signal);
  const sidecar = new LlamaSidecar({
    exe: () => installer.serverExe(),
    modelPath: (m) => installer.modelPath(m),
    installed: (m) => installer.runtimeInstalled() && installer.modelInstalled(m),
    log: (l) => console.log(l),
  });
  const s = defaultSettings();
  const settings: Settings = { ...s, ai: { ...s.ai, provider: 'local', local: { model } } };
  const service = new AiService({
    getSettings: () => settings,
    keys: { get: () => null },
    local: { ensure: (m, signal) => sidecar.ensure(m, signal), touch: () => sidecar.touch() },
    inMatch: () => inMatch,
    log: (l) => console.log(l),
  });
  return { installer, sidecar, service };
}

/** Процессорное время процесса, мс (PowerShell); null — не удалось */
export function cpuMs(pid: number): Promise<number | null> {
  return new Promise((r) => {
    execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { windowsHide: true, timeout: 10_000 }, (err, out) =>
      r(err ? null : Number(out.trim().replace(',', '.')) || null),
    );
  });
}

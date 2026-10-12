import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySettingsPatch,
  defaultSettings,
  settingsSchema,
  type Settings,
  type SettingsPatch,
} from '@shared/schemas/settings';

/**
 * Настройки в settings.json. Запись атомарная (через временный файл),
 * повреждённый файл не удаляется, а сохраняется рядом с пометкой .corrupt.
 */
export class SettingsStore {
  private readonly file: string;
  private current: Settings;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'settings.json');
    this.current = this.load();
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  update(patch: SettingsPatch): Settings {
    this.current = applySettingsPatch(this.current, patch);
    this.save();
    return this.get();
  }

  private load(): Settings {
    if (!existsSync(this.file)) return defaultSettings();
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      return settingsSchema.parse(raw);
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        copyFileSync(this.file, `${this.file}.corrupt-${stamp}`);
      } catch {
        /* резервную копию сделать не удалось — продолжаем с настройками по умолчанию */
      }
      return defaultSettings();
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}

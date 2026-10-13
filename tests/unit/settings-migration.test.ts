// Обновление через вкладку «Обновления» (0.7.1 → новая версия) меняет только app.asar: settings.json остаётся
// старым. Файлы tests/fixtures/settings/*.json сохранены схемами из истории git — так, как их записала бы
// та версия (SettingsStore.save: JSON.stringify(settings, null, 2)):
//   settings-0.7.1.json      — релиз 0.7.1 (78eac6e), не значения по умолчанию;
//   settings-0.8.0.json      — релиз 0.8.0 (fc95d95), без разделов hints и gsi;
//   settings-0.8.0-gsi.json  — сборка с GSI (b0caa08, проверка на Доте 2026-10-13): секрет, порт, папка Dota с кириллицей.
import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../../src/main/settings/store';
import { defaultSettings } from '../../src/shared/schemas/settings';

const FIX = join(import.meta.dirname, '../fixtures/settings');
const raw = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as Record<string, any>;

/** Папка данных с файлом настроек указанной версии */
function dataDirWith(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dotacoach-settings-'));
  copyFileSync(join(FIX, name), join(dir, 'settings.json'));
  return dir;
}

/** Каждое значение старого файла сохранилось в новых настройках */
function expectKept(old: Record<string, any>, now: Record<string, any>): void {
  for (const [section, values] of Object.entries(old)) {
    if (values && typeof values === 'object') for (const [k, v] of Object.entries(values)) expect(now[section]?.[k]).toEqual(v);
    else expect(now[section]).toEqual(values);
  }
}

describe('настройки после обновления', () => {
  it('файл 0.7.1 читается без ошибок, все значения на месте; новые разделы — по умолчанию', () => {
    const dir = dataDirWith('settings-0.7.1.json');
    const store = new SettingsStore(dir);
    const s = store.get();
    expectKept(raw('settings-0.7.1.json'), s);
    expect(s.hints).toEqual(defaultSettings().hints);
    expect(s.gsi).toEqual({ port: 53790, token: '', record: true, dotaDir: null });
    // Файл не испорчен и не переименован в .corrupt
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it('файл 0.7.1: после создания секрета GSI (первый запуск новой версии) старые значения не теряются', () => {
    const dir = dataDirWith('settings-0.7.1.json');
    new SettingsStore(dir).updateGsiInternal({ token: 'c'.repeat(64) });
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expectKept(raw('settings-0.7.1.json'), saved);
    expect(saved.gsi.token).toBe('c'.repeat(64));
    // И повторный запуск читает то же самое
    const again = new SettingsStore(dir).get();
    expectKept(raw('settings-0.7.1.json'), again);
    expect(again.gsi.token).toBe('c'.repeat(64));
  });

  it('файл 0.8.0 (без hints и gsi) и файл сборки с GSI читаются без потерь', () => {
    for (const name of ['settings-0.8.0.json', 'settings-0.8.0-gsi.json']) {
      const dir = dataDirWith(name);
      const s = new SettingsStore(dir).get();
      expectKept(raw(name), s);
      expect(readdirSync(dir)).toEqual(['settings.json']);
    }
    const gsi = new SettingsStore(dataDirWith('settings-0.8.0-gsi.json')).get().gsi;
    expect(gsi).toEqual({ port: 54321, token: 'ab'.repeat(32), record: false, dotaDir: 'D:\\Игры\\Steam Library\\steamapps\\common\\dota 2 beta' });
  });
});

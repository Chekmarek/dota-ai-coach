import { describe, expect, it } from 'vitest';
import { detectDotaVideo, libraryPaths, modeFromVideo, parseKeyValues } from '../../src/main/live/dota-video';

describe('режим экрана Доты (video.txt, только чтение)', () => {
  it('сопоставляет настройки с режимом', () => {
    expect(modeFromVideo('1', '0')).toBe('exclusive');
    expect(modeFromVideo('0', '1')).toBe('borderless');
    expect(modeFromVideo('1', '1')).toBe('borderless');
    expect(modeFromVideo('0', '0')).toBe('windowed');
    expect(modeFromVideo(null, null)).toBe('unknown');
  });

  it('разбирает KeyValues и библиотеки Steam', () => {
    expect(parseKeyValues('"config"\n{\n\t"setting.fullscreen"\t\t"0"\n\t"Setting.NoWindowBorder"\t"1"\n}')).toEqual({
      'setting.fullscreen': '0',
      'setting.nowindowborder': '1',
    });
    expect(libraryPaths('C:\\Steam', '"0" { "path" "C:\\\\Steam" } "1" { "path" "D:\\\\SteamLibrary" }')).toEqual(['C:\\Steam', 'D:\\SteamLibrary']);
  });

  it('находит video.txt во второй библиотеке; без Steam — unknown', async () => {
    const files: Record<string, string> = {
      'C:\\Steam\\steamapps\\libraryfolders.vdf': '"1" { "path" "D:\\\\Lib" }',
      'D:\\Lib\\steamapps\\common\\dota 2 beta\\game\\dota\\cfg\\video.txt': '"setting.fullscreen" "1"\n"setting.nowindowborder" "0"',
    };
    const read = async (f: string) => {
      if (f in files) return files[f]!;
      throw new Error('ENOENT');
    };
    const res = await detectDotaVideo({ steamPath: 'C:\\Steam', read });
    expect(res.mode).toBe('exclusive');
    expect(res.file).toContain('D:\\Lib');
    expect((await detectDotaVideo({ steamPath: null, read })).mode).toBe('unknown');
  });
});

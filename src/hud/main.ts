// Окно подсказок поверх игры: прозрачное, без фокуса, пропускает клики (настраивает main, src/main/live/hud-window.ts).
// Получает только состояние подсказок (проверяется zod) и рисует его. Своих таймеров нет — процессор в простое не занят.
// Для снимков тем и проверки без игры: #demo=alive|dead|match&theme=runes|obsidian&detail=min|normal|detailed&bg=schematic
import './hud.css';
import './schematic.css';
import { DEFAULT_HUD_OPTIONS, hudStateSchema, type HudOptions } from '../shared/types/hud.ts';
import { DEFAULT_LAYOUT, HudView } from './view.ts';
import { sampleHints, type SampleScene } from '../shared/hud-samples.ts';
import { schematic } from './schematic.ts';
import { modeBannerText } from '../core/gsi/mode.ts';

declare global {
  interface Window {
    dotacoachHud?: { onState(fn: (state: unknown) => void): void };
  }
}

let options: HudOptions = DEFAULT_HUD_OPTIONS;
const view = new HudView(document.body, innerWidth, innerHeight, options);

window.dotacoachHud?.onState((raw) => {
  const s = hudStateSchema.safeParse(raw);
  if (!s.success) return;
  options = s.data.options;
  view.configure(innerWidth, innerHeight, options);
  view.update(s.data.hints);
  view.setMode(s.data.mode);
  view.setFocus(s.data.focus);
});

addEventListener('resize', () => view.configure(innerWidth, innerHeight, options));

const demo = new URLSearchParams(location.hash.slice(1));
if (demo.has('demo')) {
  const asked = demo.get('theme');
  const theme = asked === 'obsidian' || asked === 'teal' || asked === 'dota' ? asked : 'runes';
  const detail = (demo.get('detail') as 'min' | 'normal' | 'detailed' | null) ?? 'normal';
  options = { ...options, theme, reduceMotion: demo.has('still') };
  if (demo.get('bg') === 'schematic') document.body.prepend(schematic(DEFAULT_LAYOUT, innerWidth, innerHeight));
  view.configure(innerWidth, innerHeight, options);
  const scene = demo.get('demo') ?? 'alive';
  // #demo=mode-turbo|mode-all-pick|mode-unknown — индикатор режима (для снимков и проверки без игры)
  if (scene.startsWith('mode-')) {
    const mode = scene.slice(5) as 'turbo' | 'all-pick' | 'unknown';
    const info = { mode, source: demo.has('manual') ? 'manual' : mode === 'unknown' ? 'none' : 'gsi', raw: null } as const;
    view.setMode({ seq: 1, mode, source: info.source, ...modeBannerText(info) });
  } else view.update(sampleHints(scene as SampleScene, detail));
}

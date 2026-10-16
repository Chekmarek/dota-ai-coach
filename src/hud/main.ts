// Окно подсказок поверх игры: прозрачное, без фокуса, пропускает клики (настраивает main, src/main/live/hud-window.ts).
// Получает только состояние подсказок (проверяется zod) и рисует его. Своих таймеров нет — процессор в простое не занят.
// Для снимков тем и проверки без игры: #demo=alive|dead|match&theme=arcane|void&detail=min|normal|detailed&bg=schematic
import './hud.css';
import './schematic.css';
import { DEFAULT_HUD_OPTIONS, hudStateSchema, type HudOptions } from '../shared/types/hud.ts';
import { DEFAULT_LAYOUT, HudView } from './view.ts';
import { sampleHints, type SampleScene } from '../shared/hud-samples.ts';
import { schematic } from './schematic.ts';

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
});

addEventListener('resize', () => view.configure(innerWidth, innerHeight, options));

const demo = new URLSearchParams(location.hash.slice(1));
if (demo.has('demo')) {
  const theme = demo.get('theme') === 'void' ? 'void' : 'arcane';
  const detail = (demo.get('detail') as 'min' | 'normal' | 'detailed' | null) ?? 'normal';
  options = { ...options, theme, reduceMotion: demo.has('still') };
  if (demo.get('bg') === 'schematic') document.body.prepend(schematic(DEFAULT_LAYOUT, innerWidth, innerHeight));
  view.configure(innerWidth, innerHeight, options);
  view.update(sampleHints((demo.get('demo') as SampleScene) ?? 'alive', detail));
}

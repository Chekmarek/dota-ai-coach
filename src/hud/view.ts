// HudView — рисует подсказки по зонам: появление из края зоны, уход, плавная перестройка стопки (FLIP),
// пульс свечения у критичных. Таймеров и циклов нет: работа только когда пришло новое состояние,
// анимации — Web Animations API на transform/opacity (видеокарта). Используется оверлеем и предпросмотром.
import layoutJson from '../data/hud-overlay-layout.json';
import { applyOverrides, hudUnit, layoutSchema, resolveLayout, type HudLayout, type HudZoneId, type ResolvedZone } from '../core/hud/layout.ts';
import type { HudHint, HudOptions } from '../shared/types/hud.ts';
import { themeById, themeVars, type HudTheme } from './theme/index.ts';
import { MOTION, type Edge } from './theme/motion.ts';
import { cardContent, contentKey, renderHint } from './components/cards.ts';
import { h } from './components/dom.ts';

export const DEFAULT_LAYOUT: HudLayout = layoutSchema.parse(layoutJson);

interface Mounted {
  hint: HudHint;
  el: HTMLElement;
  key: string;
  leaving: boolean;
}

export class HudView {
  readonly root: HTMLElement;
  private zoneEls = new Map<HudZoneId, HTMLElement>();
  private zoneInfo = new Map<HudZoneId, ResolvedZone>();
  private mounted = new Map<number, Mounted>();
  private theme: HudTheme;
  private options: HudOptions;
  private width: number;
  private height: number;
  private layout: HudLayout = DEFAULT_LAYOUT;

  constructor(host: HTMLElement, width: number, height: number, options: HudOptions) {
    this.root = h('div', 'hud-root');
    host.append(this.root);
    this.width = width;
    this.height = height;
    this.options = options;
    this.theme = themeById(options.theme);
    this.build();
  }

  get reduced(): boolean {
    return this.options.reduceMotion || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** Новые настройки или размер экрана: пересобрать зоны (карточки переносятся без анимации) */
  configure(width: number, height: number, options: HudOptions, layout: HudLayout = DEFAULT_LAYOUT): void {
    const same = width === this.width && height === this.height && JSON.stringify(options) === JSON.stringify(this.options) && layout === this.layout;
    if (same) return;
    this.width = width;
    this.height = height;
    this.options = options;
    this.layout = layout;
    this.theme = themeById(options.theme);
    this.build();
  }

  private build(): void {
    const u = hudUnit(this.width, this.height);
    const vars = themeVars(this.theme, u, this.options.scale, this.options.opacity);
    for (const [k, v] of Object.entries(vars)) this.root.style.setProperty(k, v);
    this.root.classList.toggle('hud-reduced', this.options.reduceMotion);
    this.root.dataset['theme'] = this.theme.id;
    const resolved = resolveLayout(applyOverrides(this.layout, this.options.zones), this.width, this.height);
    for (const z of resolved.zones) {
      let el = this.zoneEls.get(z.zone.id);
      if (!el) {
        el = h('div', 'hud-zone');
        el.dataset['zone'] = z.zone.id;
        this.root.append(el);
        this.zoneEls.set(z.zone.id, el);
      }
      el.className = `hud-zone hud-stack-${z.zone.stack} hud-align-${z.zone.ax === 'right' ? 'right' : z.zone.ax === 'center' ? 'center' : 'left'}${z.zone.compact ? ' hud-compact' : ''}`;
      Object.assign(el.style, { left: `${z.rect.x}px`, top: `${z.rect.y}px`, width: `${z.rect.w}px`, height: `${z.rect.h}px` });
      this.zoneInfo.set(z.zone.id, z);
    }
  }

  /** Прямоугольники зон в пикселях (для режима расстановки) */
  zones(): ResolvedZone[] {
    return [...this.zoneInfo.values()];
  }

  private edge(zone: HudZoneId): Edge {
    return this.zoneInfo.get(zone)?.zone.from ?? 'right';
  }

  private animate(el: Element, preset: { keyframes: Keyframe[]; options: KeyframeAnimationOptions } | null): Animation | null {
    if (!preset || typeof (el as HTMLElement).animate !== 'function') return null;
    return (el as HTMLElement).animate(preset.keyframes, preset.options);
  }

  /** Показать ровно эти подсказки (порядок внутри зоны — как в списке) */
  update(hints: readonly HudHint[]): void {
    const reduced = this.reduced;
    const want = new Map(hints.map((x) => [x.seq, x]));
    // FLIP: запомнить, где стояли карточки
    const before = new Map<number, DOMRect>();
    for (const [seq, m] of this.mounted) if (!m.leaving) before.set(seq, m.el.getBoundingClientRect());

    // Уход
    for (const [seq, m] of this.mounted) {
      if (want.has(seq) || m.leaving) continue;
      m.leaving = true;
      const anim = this.animate(m.el, MOTION.exit(this.theme, this.edge(m.hint.zone), reduced));
      const done = () => {
        m.el.remove();
        this.mounted.delete(seq);
      };
      if (anim) anim.onfinish = done;
      else done();
    }

    // Новые и обновлённые
    const entered: Mounted[] = [];
    for (const hint of hints) {
      const zoneEl = this.zoneEls.get(hint.zone);
      if (!zoneEl) continue;
      const m = this.mounted.get(hint.seq);
      if (!m) {
        const el = renderHint(hint);
        const mm: Mounted = { hint, el, key: contentKey(hint), leaving: false };
        this.mounted.set(hint.seq, mm);
        zoneEl.append(el);
        entered.push(mm);
        continue;
      }
      if (m.leaving) continue;
      const key = contentKey(hint);
      if (key !== m.key) {
        m.el.className = renderHint(hint).className;
        m.el.replaceChildren(...cardContent(hint));
        m.key = key;
        this.animate(m.el.querySelector('.hud-body') ?? m.el, MOTION.update(this.theme, reduced));
        if (hint.priority === 'critical' && m.hint.priority !== 'critical') this.pulse(m.el, reduced);
      }
      m.hint = hint;
      if (m.el.parentElement !== zoneEl) zoneEl.append(m.el);
    }

    // Порядок в зонах — как в списке
    for (const [zone, zoneEl] of this.zoneEls) {
      const order = hints.filter((x) => x.zone === zone).map((x) => this.mounted.get(x.seq)?.el).filter((x): x is HTMLElement => !!x);
      for (const el of order) zoneEl.append(el);
      // уходящие остаются в конце, пока не доиграют
      for (const m of this.mounted.values()) if (m.leaving && m.el.parentElement === zoneEl) zoneEl.append(m.el);
    }

    // FLIP: перенос оставшихся
    for (const [seq, rect] of before) {
      const m = this.mounted.get(seq);
      if (!m || m.leaving) continue;
      const now = m.el.getBoundingClientRect();
      this.animate(m.el, MOTION.reflow(this.theme, rect.left - now.left, rect.top - now.top, reduced));
    }
    for (const m of entered) {
      this.animate(m.el, MOTION.enter(this.theme, this.edge(m.hint.zone), reduced));
      if (m.hint.priority === 'critical') this.pulse(m.el, reduced);
    }
  }

  private pulse(card: HTMLElement, reduced: boolean): void {
    const glow = card.querySelector('.hud-glow');
    if (glow) this.animate(glow, MOTION.pulse(this.theme, reduced));
  }

  /** Сколько карточек на экране (для оверлея: прятать окно, когда пусто) */
  get count(): number {
    return [...this.mounted.values()].filter((m) => !m.leaving).length;
  }
  get animating(): boolean {
    return [...this.mounted.values()].some((m) => m.leaving);
  }

  destroy(): void {
    this.root.remove();
    this.mounted.clear();
  }
}

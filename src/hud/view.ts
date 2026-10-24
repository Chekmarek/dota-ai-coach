// HudView — рисует подсказки по зонам: появление из края зоны, уход, плавная перестройка стопки (FLIP),
// пульс свечения у критичных. Таймеров и циклов нет: работа только когда пришло новое состояние,
// анимации — Web Animations API на transform/opacity (видеокарта). Используется оверлеем и предпросмотром.
import layoutJson from '../data/hud-overlay-layout.json';
import { applyOverrides, hudUnit, layoutSchema, resolveLayout, type HudLayout, type HudZoneId, type ResolvedZone } from '../core/hud/layout.ts';
import type { HudFocus, HudHint, HudOptions, ModeBanner } from '../shared/types/hud.ts';
import { themeById, themeVars, type HudTheme } from './theme/index.ts';
import { MOTION, type Edge } from './theme/motion.ts';
import { applyTtl, cardContent, contentKey, renderHint } from './components/cards.ts';
import { h } from './components/dom.ts';
import { renderModeBanner } from './components/mode.ts';

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
  /** Индикатор режима: место (по зоне «Важное») и показанная плашка */
  private modeSlot: HTMLElement | null = null;
  private modeEl: { seq: number; el: HTMLElement; leaving: boolean } | null = null;

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
      el.hidden = this.options.hiddenZones.includes(z.zone.id);
      el.className = `hud-zone hud-stack-${z.zone.stack} hud-align-${z.zone.ax === 'right' ? 'right' : z.zone.ax === 'center' ? 'center' : 'left'}${z.zone.compact ? ' hud-compact' : ''}`;
      Object.assign(el.style, { left: `${z.rect.x}px`, top: `${z.rect.y}px`, width: `${z.rect.w}px`, height: `${z.rect.h}px` });
      this.zoneInfo.set(z.zone.id, z);
    }
    // Индикатор режима — сверху зоны «Важное» (под верхней панелью Dota, вне HUD игры)
    const alert = this.zoneInfo.get('alert')?.rect;
    if (!this.modeSlot) {
      this.modeSlot = h('div', 'hud-mode-slot');
      this.root.append(this.modeSlot);
    }
    if (alert) Object.assign(this.modeSlot.style, { position: 'absolute', left: `${alert.x}px`, top: `${alert.y}px`, width: `${alert.w}px`, display: 'flex', justifyContent: 'center' });
  }

  /** Показать индикатор режима (новый seq — новая анимация) или убрать его (null) */
  setMode(banner: ModeBanner | null): void {
    const reduced = this.reduced;
    if (banner && this.modeEl && !this.modeEl.leaving && this.modeEl.seq === banner.seq) return;
    if (this.modeEl && !this.modeEl.leaving) {
      const old = this.modeEl;
      old.leaving = true;
      const anim = this.animate(old.el, MOTION.modeExit(this.theme, reduced));
      const done = () => {
        old.el.remove();
        if (this.modeEl === old) this.modeEl = null;
      };
      if (anim) anim.onfinish = done;
      else done();
    }
    if (!banner || !this.modeSlot) return;
    const el = renderModeBanner(banner);
    el.style.position = 'relative';
    this.modeSlot.append(el);
    this.modeEl = { seq: banner.seq, el, leaving: false };
    this.animate(el, MOTION.modeEnter(this.theme, reduced));
    const icon = el.querySelector('.hud-mode-icon');
    if (icon) {
      const pop = this.animate(icon, MOTION.modeIcon(this.theme, reduced));
      if (banner.mode === 'turbo') {
        const charge = () => this.animate(icon, MOTION.modeCharge(this.theme, reduced));
        if (pop) pop.onfinish = charge;
        else charge();
      }
    }
    const sweep = el.querySelector('.hud-mode-sweep');
    if (sweep) this.animate(sweep, MOTION.modeSweep(this.theme, reduced));
    const glow = el.querySelector('.hud-glow');
    if (glow) this.animate(glow, MOTION.flash(this.theme, reduced));
  }

  /**
   * Счётчик фокуса матча: маленькая плашка в постоянном месте — справа сверху, под кнопками Доты (вне зон подсказок).
   * null — убрать. Смена числа — короткое проявление.
   */
  setFocus(f: HudFocus | null): void {
    if (!f) {
      this.focusEl?.remove();
      this.focusEl = null;
      this.focusKey = '';
      return;
    }
    if (!this.focusEl) {
      this.focusEl = h('div', 'hud-focus-pill');
      this.root.append(this.focusEl);
    }
    const u = hudUnit(this.width, this.height);
    Object.assign(this.focusEl.style, { right: `${0.012 * u}px`, top: `${0.056 * u}px` });
    const key = JSON.stringify(f);
    if (key === this.focusKey) return;
    const changed = this.focusKey !== '';
    this.focusKey = key;
    this.focusEl.dataset['state'] = f.state;
    this.focusEl.replaceChildren(h('i', 'hud-focus-dot', null), h('span', null, `Фокус · ${f.label}`), h('b', null, f.progress));
    if (changed) this.animate(this.focusEl, MOTION.update(this.theme, this.reduced));
  }
  private focusEl: HTMLElement | null = null;
  private focusKey = '';

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
  update(all: readonly HudHint[]): void {
    const reduced = this.reduced;
    // Скрытые пользователем зоны не рисуем вовсе (подсказки в них уходят, как устаревшие)
    const hints = all.filter((x) => !this.options.hiddenZones.includes(x.zone));
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
      applyTtl(m.el, hint);
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
    this.markOverflow();
    for (const m of entered) {
      this.animate(m.el, MOTION.enter(this.theme, this.edge(m.hint.zone), reduced));
      if (m.hint.priority === 'critical') this.pulse(m.el, reduced);
      else {
        const glow = m.el.querySelector('.hud-glow');
        if (glow) this.animate(glow, MOTION.flash(this.theme, reduced));
      }
    }
  }

  /** Карточки, не влезающие в зону целиком, прячем (зона — граница безопасной области) */
  private markOverflow(): void {
    for (const [zone, zoneEl] of this.zoneEls) {
      const r = this.zoneInfo.get(zone)?.rect;
      if (!r) continue;
      let used = 0;
      const gap = parseFloat(getComputedStyle(zoneEl).rowGap) || 0;
      const pad = parseFloat(getComputedStyle(zoneEl).paddingTop) || 0;
      for (const el of [...zoneEl.children] as HTMLElement[]) {
        if ([...this.mounted.values()].some((m) => m.el === el && m.leaving)) continue;
        const h = el.offsetHeight;
        const fits = used + h <= r.h - pad * 2 + 0.5;
        el.classList.toggle('hud-overflow', !fits);
        if (fits) used += h + gap;
      }
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
    return [...this.mounted.values()].some((m) => m.leaving) || !!this.modeEl?.leaving;
  }

  destroy(): void {
    this.root.remove();
    this.mounted.clear();
  }
}

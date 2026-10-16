// «Предпросмотр подсказок» (этап 3): все виды подсказок на снимке игры (или схеме HUD) с переключателями темы,
// экрана, подробности и анимаций; «Режим расстановки» — перетаскивание зон, сброс к стандартной.
// Рисуют те же компоненты, что и окно поверх игры (src/hud), поэтому редизайн = правка токенов + проверка здесь.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import '../../hud/hud.css';
import '../../hud/schematic.css';
import { useSettings } from '../hooks/useSettings';
import { useEngine } from '../hooks/useEngine';
import { isLive } from '../components/live';
import { Card, PageHeader } from '../components/ui';
import { HudView, DEFAULT_LAYOUT } from '../../hud/view';
import { schematic } from '../../hud/schematic';
import { THEMES } from '../../hud/theme';
import { SAMPLE_SCENES, sampleHints, type SampleScene } from '@shared/hud-samples';
import { DEFAULT_HUD_OPTIONS, HUD_THEME_IDS, type HudOptions, type HudThemeId } from '@shared/types/hud';
import { SCREENS, applyOverrides, moveZone, resolveLayout, type ZoneOverrides, type HudZoneId } from '@core/hud/layout';

type Background = 'schematic' | 'live' | 'file';
type Detail = 'min' | 'normal' | 'detailed';
const DETAIL_RU: Record<Detail, string> = { min: 'Минимум', normal: 'Обычный', detailed: 'Подробно' };

export function HudPreview() {
  const { settings, update, error } = useSettings();
  const { status, preview } = useEngine();
  const [scene, setScene] = useState<SampleScene>('alive');
  const [screenId, setScreenId] = useState('16x9');
  const [detail, setDetail] = useState<Detail>('normal');
  const [bg, setBg] = useState<Background>('schematic');
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ZoneOverrides | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stageScale, setStageScale] = useState(0.5);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HudView | null>(null);
  const drag = useRef<{ zone: HudZoneId; x0: number; y0: number; base: { x: number; y: number } } | null>(null);

  const screen = SCREENS.find((s) => s.id === screenId) ?? SCREENS[0]!;
  const h = settings?.hud;
  const zones = draft ?? h?.zones ?? null;
  const options: HudOptions = useMemo(
    () => (h ? { theme: h.theme, reduceMotion: h.reduceMotion, opacity: h.opacity, scale: h.scale, zones } : { ...DEFAULT_HUD_OPTIONS, zones }),
    [h, zones],
  );
  const resolved = useMemo(() => resolveLayout(applyOverrides(DEFAULT_LAYOUT, zones), screen.width, screen.height), [zones, screen]);
  const live = isLive(status) ? status.live : null;
  const exclusive = live?.videoMode === 'exclusive';

  // Масштаб сцены под ширину страницы
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => setStageScale(Math.min(1, el.clientWidth / screen.width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [screen.width]);

  // Подсказки рисует тот же HudView, что и окно поверх игры
  useEffect(() => {
    if (!hostRef.current) return;
    viewRef.current = new HudView(hostRef.current, screen.width, screen.height, options);
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // пересоздаём только при смене экрана; остальное — configure ниже
  }, [screen.width, screen.height]);
  useEffect(() => {
    viewRef.current?.configure(screen.width, screen.height, options);
    viewRef.current?.update(sampleHints(scene, detail));
  }, [options, scene, detail, screen]);

  // Фон: схема HUD, последний кадр игры или свой снимок
  useEffect(() => {
    const el = bgRef.current;
    if (!el) return;
    el.replaceChildren();
    const url = bg === 'live' ? (preview?.url ?? null) : bg === 'file' ? fileUrl : null;
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.className = 'hudp-bgimg';
      img.alt = '';
      el.append(img);
    } else el.append(schematic(DEFAULT_LAYOUT, screen.width, screen.height));
  }, [bg, preview?.url, fileUrl, screen]);

  useEffect(() => () => void (fileUrl && URL.revokeObjectURL(fileUrl)), [fileUrl]);

  if (!settings || !h) return null;

  const replay = () => {
    viewRef.current?.update([]);
    setTimeout(() => viewRef.current?.update(sampleHints(scene, detail)), 350);
  };

  const onDown = (zone: HudZoneId) => (e: ReactPointerEvent) => {
    if (!editing) return;
    const z = resolved.zones.find((x) => x.zone.id === zone)!.zone;
    drag.current = { zone, x0: e.clientX, y0: e.clientY, base: { x: z.x, y: z.y } };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const z = DEFAULT_LAYOUT.zones.find((x) => x.id === d.zone)!;
    const next = moveZone({ ...z, ...d.base }, (e.clientX - d.x0) / stageScale, (e.clientY - d.y0) / stageScale, screen.width, screen.height);
    setDraft({ ...(zones ?? {}), [d.zone]: next });
  };
  const onUp = async () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !draft) return;
    const bad = resolveLayout(applyOverrides(DEFAULT_LAYOUT, draft), screen.width, screen.height).zones.find((z) => z.zone.id === d.zone && (z.conflicts.length || z.offscreen));
    if (bad) {
      setNote(`Зона «${bad.zone.nameRu}» заходит на HUD игры (${bad.conflicts.join(', ') || 'за край экрана'}) — возвращена на место.`);
      setDraft(null);
      return;
    }
    setNote(null);
    await update({ hud: { zones: draft } });
    setDraft(null);
  };

  return (
    <>
      <PageHeader title="Предпросмотр подсказок" subtitle="Так подсказки выглядят поверх игры. Те же карточки, что и в матче: смените тему, экран или подробность и посмотрите сразу." />
      {exclusive && (
        <p className="warn" data-testid="hud-exclusive">
          Dota запущена в режиме «Полноэкранный»: Windows не даёт рисовать поверх такой игры. Включите в Dota «Полноэкранный в окне» (Настройки → Видео → Режим экрана).
        </p>
      )}
      <Card title="Вид">
        <div className="form hudp-controls">
          <label className="check">
            <input type="checkbox" checked={h.enabled} onChange={(e) => void update({ hud: { enabled: e.target.checked } })} data-testid="hud-enabled" />
            Показывать подсказки поверх игры
          </label>
          <label>
            Тема
            <select value={h.theme} onChange={(e) => void update({ hud: { theme: e.target.value as HudThemeId } })} data-testid="hud-theme">
              {HUD_THEME_IDS.map((id) => (
                <option key={id} value={id}>
                  {THEMES[id].nameRu} — {THEMES[id].noteRu.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <label>
            Сцена
            <select value={scene} onChange={(e) => setScene(e.target.value as SampleScene)}>
              {SAMPLE_SCENES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nameRu}
                </option>
              ))}
            </select>
          </label>
          <label>
            Экран
            <select value={screenId} onChange={(e) => setScreenId(e.target.value)} data-testid="hud-screen">
              {SCREENS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nameRu}
                </option>
              ))}
            </select>
          </label>
          <label>
            Подробность
            <select value={detail} onChange={(e) => setDetail(e.target.value as Detail)}>
              {(Object.keys(DETAIL_RU) as Detail[]).map((d) => (
                <option key={d} value={d}>
                  {DETAIL_RU[d]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Фон
            <select value={bg} onChange={(e) => setBg(e.target.value as Background)}>
              <option value="schematic">Схема HUD Dota</option>
              <option value="live" disabled={!preview}>
                Последний кадр игры{preview ? '' : ' (нет кадра)'}
              </option>
              <option value="file" disabled={!fileUrl}>
                Свой снимок{fileUrl ? '' : ' (выберите файл)'}
              </option>
            </select>
          </label>
          <label>
            Свой снимок игры
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setFileUrl(URL.createObjectURL(f));
                setBg('file');
              }}
            />
          </label>
          <label>
            Прозрачность: {Math.round(h.opacity * 100)}%
            <input type="range" min={0.4} max={1} step={0.05} value={h.opacity} onChange={(e) => void update({ hud: { opacity: Number(e.target.value) } })} />
          </label>
          <label>
            Размер: {Math.round(h.scale * 100)}%
            <input type="range" min={0.8} max={1.4} step={0.05} value={h.scale} onChange={(e) => void update({ hud: { scale: Number(e.target.value) } })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={h.reduceMotion} onChange={(e) => void update({ hud: { reduceMotion: e.target.checked } })} />
            Уменьшить анимации
          </label>
        </div>
        <div className="row">
          <button onClick={replay}>Проиграть появление</button>
          <button onClick={() => void window.dotacoach.showHudDemo(scene)} title="Примеры появятся поверх окна игры на 12 секунд" data-testid="hud-demo">
            Показать поверх игры
          </button>
          <button className={editing ? 'primary' : ''} onClick={() => setEditing(!editing)} data-testid="hud-edit">
            {editing ? 'Готово' : 'Режим расстановки'}
          </button>
          <button onClick={() => void update({ hud: { zones: null } })} disabled={!h.zones}>
            Сбросить расстановку
          </button>
        </div>
        {editing && <p className="muted small">Перетащите зону мышью. Красная рамка — зона заходит на HUD игры: так её не сохранить.</p>}
        {note && <p className="warn small">{note}</p>}
        {error && <p className="error small">{error}</p>}
      </Card>

      <div className="hudp-wrap" ref={wrapRef} style={{ height: screen.height * stageScale }}>
        <div className="hudp-stage" style={{ width: screen.width, height: screen.height, transform: `scale(${stageScale})` }} data-testid="hud-stage">
          <div className="hudp-bg" ref={bgRef} />
          <div className="hudp-host" ref={hostRef} />
          {editing && (
            <div className="hudp-edit" onPointerMove={onMove} onPointerUp={() => void onUp()}>
              {resolved.zones.map((z) => (
                <div
                  key={z.zone.id}
                  className={`hudp-zone${z.conflicts.length || z.offscreen ? ' hudp-bad' : ''}`}
                  style={{ left: z.rect.x, top: z.rect.y, width: z.rect.w, height: z.rect.h }}
                  onPointerDown={onDown(z.zone.id)}
                  data-testid={`hud-zone-${z.zone.id}`}
                >
                  <span>{z.zone.nameRu}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

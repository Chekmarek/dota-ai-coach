// Точность зрения коуча на своих записях матчей — против STRATZ (docs/VISION_ACCURACY.md). Только для разработчика.
// Кадры набора (vision-dataset, свой матч: в .json тело GSI игрока с matchid) проходят тот же путь, что в коуче:
// зрение (как src/engine/vision.ts) → модель матча (GSI + кадры) → снимок для правил (buildView). То, что коуч
// «знает» на этом кадре, сверяется с playbackData STRATZ на той же секунде игры (часы GSI + возраст тела).
//   node scripts/vision-vs-stratz.mjs <папка набора> <файл STRATZ match.json> [--out <jsonl>] [--step N]
// Файл STRATZ: { data: { match } } или { match } — players { playerSlot heroId isRadiant playbackData { … } }.
// Мир = клетка STRATZ × 128 − 16240: подобрано по записи матча с GSI наблюдателя (15 371 точка, все 10 героев,
// медиана расхождения ~100 ед.).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { frameAccessFromImage } from '../src/core/vision/image.ts';
import { recognizeHud } from '../src/core/vision/recognize-hud.ts';
import { readTopBar } from '../src/core/vision/top-bar.ts';
import { decodeMinimapBackground, readMinimap } from '../src/core/vision/minimap.ts';
import { MinimapCalibrator } from '../src/core/vision/minimap-calibration.ts';
import { MinimapTracker } from '../src/core/vision/minimap-track.ts';
import { readHealthBars } from '../src/core/vision/health-bars.ts';
import { MatchStateModel } from '../src/core/match-state/index.ts';
import { mapGsi } from '../src/core/gsi/index.ts';
import { buildView, ENEMY_BAR_MIN_CONFIDENCE } from '../src/core/coach/view.ts';
import { nearEnemyCount } from '../src/core/coach/memory.ts';
import { NEAR_UNITS } from '../src/core/coach/geo.ts';

const root = join(import.meta.dirname, '..');
const data = (f) => JSON.parse(readFileSync(join(root, 'src/data', f), 'utf8'));
const args = process.argv.slice(2);
const [dir, stratzFile] = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const step = Math.max(1, Number(opt('--step') ?? 1));
if (!dir || !stratzFile || !existsSync(dir) || !existsSync(stratzFile)) {
  console.error('Использование: node scripts/vision-vs-stratz.mjs <папка набора> <STRATZ match.json> [--out файл.jsonl] [--step N]');
  process.exit(2);
}
const rawMatch = JSON.parse(readFileSync(stratzFile, 'utf8'));
const match = rawMatch.data?.match ?? rawMatch.match ?? rawMatch;
const matchId = String(match.id);

// --- Как в движке (src/engine/vision.ts, src/engine/gsi.ts) ---
const layout = data('hud-layouts/dota2-default-16x9.json');
const model = data('hud-layouts/glyphs-default.json');
const hudOpts = {
  heroName: { model: data('hud-layouts/glyphs-heroname.json'), names: data('hero-names.json').names },
  cooldownModel: data('hud-layouts/glyphs-cooldown.json'),
  itemTemplates: data('item-templates.json'),
  aspects: data('hud-layouts/aspects.json').aspects,
};
const portraits = data('hero-portraits.json');
const background = decodeMinimapBackground(data('minimap-background.json'));
const itemNames = new Map(data('item-templates.json').items.map((i) => [i.key, i.name]));
const heroByKey = new Map(data('hero-names.json').names.map((h) => [h.key, h]));
const heroById = new Map(data('hero-names.json').names.map((h) => [h.id, h]));
const readGsi = (body) => mapGsi(body, (k) => itemNames.get(k), (k) => heroByKey.get(k));

// --- Правда STRATZ ---
const cell = (c) => c * 128 - 16240;
const truth = match.players.map((p) => {
  const pb = p.playbackData;
  const slot = p.isRadiant ? p.playerSlot : 5 + (p.playerSlot - 128);
  const deaths = (pb.deathEvents ?? []).map((d) => [d.time, d.time + Math.max(1, d.timeDead)]);
  return { slot, heroId: p.heroId, key: heroById.get(p.heroId)?.key ?? String(p.heroId), team: p.isRadiant ? 'radiant' : 'dire', pos: pb.playerUpdatePositionEvents, hp: pb.playerUpdateHealthEvents, lvl: pb.playerUpdateLevelEvents, deaths };
});
const lastAt = (ev, t) => {
  let lo = 0, hi = ev.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ev[m].time <= t) (r = m), (lo = m + 1);
    else hi = m - 1;
  }
  return r;
};
function posAt(p, t) {
  const i = lastAt(p.pos, t);
  if (i < 0) return null;
  const a = p.pos[i], b = p.pos[i + 1];
  if (!b || b.time - a.time > 2) return { x: cell(a.x), y: cell(a.y) };
  const k = (t - a.time) / (b.time - a.time);
  return { x: cell(a.x + (b.x - a.x) * k), y: cell(a.y + (b.y - a.y) * k) };
}
const hpAt = (p, t) => {
  const i = lastAt(p.hp, t);
  return i < 0 || !p.hp[i].maxHp ? null : (100 * p.hp[i].hp) / p.hp[i].maxHp;
};
const lvlAt = (p, t) => {
  const i = lastAt(p.lvl, t);
  return i < 0 ? 1 : p.lvl[i].level;
};
const aliveAt = (p, t) => !p.deaths.some(([a, b]) => t >= a && t < b);
/** Жив/мёртв меняется ближе 1,5 с — на этом кадре правду не назвать (кадр и GSI сняты не в один миг) */
const aliveEdge = (p, t) => p.deaths.some(([a, b]) => Math.abs(t - a) < 1.5 || Math.abs(t - b) < 1.5);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// --- Кадры своего матча ---
const frames = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ f, j: (() => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })() }))
  .filter(({ j }) => j?.format === 1 && j.body?.map?.matchid === matchId && j.body?.player)
  .filter((_, i) => i % step === 0);

/** Пикселей цвета игрока у позиции на мини-карте: значок нарисован (как markerPixels в vision-eval.mjs) */
function markerPixels(frame, cal, slot, w) {
  const px = Math.round((cal.ax * w.x + cal.bx) * frame.width), py = Math.round((cal.ay * w.y + cal.by) * frame.height);
  const img = frame.read({ x: px - 7, y: py - 7, w: 15, h: 15 });
  const c = layout.minimap.colors[slot], tol = layout.minimap.colorToleranceBySlot?.[String(slot)] ?? layout.minimap.colorTolerance;
  let n = 0;
  for (let y = 0; y < 15; y++)
    for (let x = 0; x < 15; x++) {
      if ((x - 7) ** 2 + (y - 7) ** 2 > 49) continue;
      const k = (y * 15 + x) * 4;
      if (Math.abs(img.data[k] - c[0]) + Math.abs(img.data[k + 1] - c[1]) + Math.abs(img.data[k + 2] - c[2]) < tol) n++;
    }
  return n;
}

const mk = () => ({ ok: 0, wrong: 0, missed: 0, rejected: 0 });
const S = {
  minimap: mk(),
  alive: mk(),
  aliveEnemy: mk(),
  hp: mk(),
  level: mk(),
  near: mk(),
  /** Против видимых врагов рядом: значок нарисован на мини-карте или полоска над героем найдена */
  nearVis: mk(),
  why: {},
  ownErr: [],
  hpErr: [],
};
const why = (k) => (S.why[k] = (S.why[k] ?? 0) + 1);
const out = [];

const matchModel = new MatchStateModel();
const calibrator = new MinimapCalibrator(layout.minimap);
const tracker = new MinimapTracker();
let lastGsi = null, lastGsiWall = null, n = 0;
for (const { f, j } of frames) {
  const png = join(dir, f.replace(/\.json$/, '.png'));
  if (!existsSync(png)) continue;
  const wallMs = j.wallMs;
  const body = j.body;
  const gsiWall = wallMs - (j.gsiAgeMs ?? 0);
  const g = readGsi(body);
  if (g && gsiWall !== lastGsiWall) {
    matchModel.ingestGsi(g, gsiWall);
    lastGsi = g;
    lastGsiWall = gsiWall;
  }
  const frame = frameAccessFromImage(decodePng(readFileSync(png)));
  // Зрение — как VisionStage.run
  const hud = recognizeHud(frame, layout, model, wallMs, hudOpts);
  hud.topBar = readTopBar(frame, layout, portraits, model);
  if (g && g.slot !== null && g.hero.x !== null && (j.gsiAgeMs ?? 0) < 300) calibrator.addSample(frame, g.slot, g.hero.x, g.hero.y, wallMs);
  const cal = calibrator.state();
  const rawMm = readMinimap(frame, layout.minimap, cal.calibration ?? null, { background });
  hud.minimap = tracker.update(rawMm, wallMs);
  hud.healthBars = readHealthBars(frame, layout, model);
  matchModel.ingest(hud, wallMs);
  const state = matchModel.snapshot(wallMs);
  const v = buildView(state, lastGsi, lastGsiWall);

  const clock = body.map.clock_time;
  if (typeof clock !== 'number' || clock < 0 || body.map.paused) continue;
  n++;
  // Секунда игры на кадре: часы целые (вниз) — +0,5; тело старше кадра на gsiAgeMs
  const t = clock + 0.5 + (j.gsiAgeMs ?? 0) / 1000;
  const ourTeam = body.player.team_name;
  const me = truth.find((p) => p.heroId === body.hero?.id);
  if (!me) continue;
  const mePos = g && g.hero.x !== null ? { x: g.hero.x, y: g.hero.y } : posAt(me, t);
  const meTrue = posAt(me, t);
  if (mePos && meTrue) S.ownErr.push(dist(mePos, meTrue));
  const enemies = truth.filter((p) => p.team !== ourTeam);
  const others = truth.filter((p) => p !== me);
  const calNow = cal.calibration;
  const row = { f, t: Math.round(t * 10) / 10, mm: [], alive: [], bars: [], near: null };

  // 1) Враги на мини-карте (то, что коуч считает «видно сейчас»: позиция не старше 1,5 с)
  for (const e of enemies) {
    const vp = v.enemies.find((p) => p.slot === e.slot);
    const tp = posAt(e, t);
    const alive = aliveAt(e, t);
    const fresh = vp && vp.pos.value && vp.pos.ageSec !== null && vp.pos.ageSec <= 1.5;
    const raw = rawMm.heroes.find((h) => h.slot === e.slot);
    if (!alive) {
      if (fresh && !aliveEdge(e, t)) (S.minimap.wrong++, why('мини-карта: значок у мёртвого врага'), row.mm.push([e.slot, 'dead']));
      continue;
    }
    if (!tp) continue;
    const pix = calNow ? markerPixels(frame, calNow, e.slot, tp) : 0;
    if (fresh) {
      const d = dist(vp.pos.value, tp);
      if (d <= 900) S.minimap.ok++;
      else {
        S.minimap.wrong++;
        const other = truth.find((o) => o !== e && aliveAt(o, t) && posAt(o, t) && dist(vp.pos.value, posAt(o, t)) <= 600);
        why(other ? `мини-карта: значок на месте другого героя (${other.team === e.team ? 'того же цвета команды' : 'другой команды'})` : 'мини-карта: значок далеко от героя');
        row.mm.push([e.slot, 'far', Math.round(d), pix]);
      }
    } else if (raw && dist(raw, tp) <= 900) (S.minimap.rejected++, why('мини-карта: найден, но отброшен сопровождением'), row.mm.push([e.slot, 'rej']));
    else if (pix >= 50) (S.minimap.missed++, why(raw ? 'мини-карта: найден не там (виден на месте)' : 'мини-карта: значок нарисован, не найден'), row.mm.push([e.slot, 'miss', pix]));
  }

  // 2) Кто жив — верхняя панель (все 9 других героев; отдельно враги)
  for (const p of others) {
    if (aliveEdge(p, t)) continue;
    const vp = [...v.enemies, ...v.allies].find((x) => x.slot === p.slot);
    const tb = hud.topBar.slots.find((s) => s.slot === p.slot);
    const truthAlive = aliveAt(p, t);
    const val = vp?.alive.value ?? null;
    for (const s of p.team !== ourTeam ? [S.alive, S.aliveEnemy] : [S.alive]) {
      if (val === null) {
        if (tb && tb.alive !== null) (s.rejected++, s === S.alive && why(`верхняя панель: прочитано «${tb.alive ? 'жив' : 'мёртв'}», не принято`));
        else (s.missed++, s === S.alive && why('верхняя панель: не прочитано'));
      } else if (val === truthAlive) s.ok++;
      else (s.wrong++, s === S.alive && why(`верхняя панель: ${truthAlive ? 'живой считается мёртвым' : 'мёртвый считается живым'}`), s === S.alive && row.alive.push([p.slot, val, truthAlive, vp.alive.ageSec]));
    }
  }

  // 3) HP и уровень видимых врагов — полоски над героями (камера у своего героя)
  const ownAlive = body.hero?.alive === true;
  if (ownAlive && mePos) {
    const cands = enemies.filter((e) => aliveAt(e, t) && posAt(e, t) && dist(posAt(e, t), mePos) <= 2200).map((e) => ({ e, hp: hpAt(e, t), lvl: lvlAt(e, t), d: dist(posAt(e, t), mePos) }));
    const enemyColor = 'red';
    const all = hud.healthBars.bars.filter((b) => b.color === enemyColor);
    const accepted = v.screen.meOnScreen ? all.filter((b) => b.confidence >= ENEMY_BAR_MIN_CONFIDENCE) : [];
    const rejected = v.screen.meOnScreen ? all.filter((b) => b.confidence < ENEMY_BAR_MIN_CONFIDENCE) : [];
    const used = new Set();
    const match1 = (b) => {
      let best = null;
      for (const c of cands) {
        if (used.has(c) || c.hp === null) continue;
        const cost = Math.abs(c.hp - b.hpPercent) + (b.level !== null && b.level !== c.lvl ? 25 : 0);
        if (!best || cost < best.cost) best = { c, cost };
      }
      return best;
    };
    for (const b of [...accepted].sort((a, b) => b.confidence - a.confidence)) {
      const m = match1(b);
      if (!m || m.cost > 40) {
        S.hp.wrong++;
        why(cands.length ? 'полоска: не совпала ни с одним врагом рядом' : 'полоска: врага рядом нет (ложная)');
        row.bars.push(['false', Math.round(b.hpPercent), b.level, Math.round(b.confidence * 100) / 100, b.x, b.y]);
        continue;
      }
      used.add(m.c);
      const err = Math.abs(m.c.hp - b.hpPercent);
      S.hpErr.push(err);
      if (err <= 10) S.hp.ok++;
      else (S.hp.wrong++, why('полоска: HP мимо больше чем на 10%'), row.bars.push(['hp', Math.round(b.hpPercent), Math.round(m.c.hp)]));
      row.lv = [...(row.lv ?? []), [b.level, m.c.lvl, Math.round(b.levelConfidence * 100) / 100]];
      if (b.level === null) (S.level.missed++, why('полоска: уровень не прочитан'));
      else if (b.level === m.c.lvl) S.level.ok++;
      else (S.level.wrong++, why('полоска: уровень неверный'), row.bars.push(['lvl', b.level, m.c.lvl]));
    }
    for (const b of rejected) {
      const m = match1(b);
      if (m && m.cost <= 15) (used.add(m.c), S.hp.rejected++, why('полоска: настоящая, но отброшена как неуверенная'));
    }
    // Пропущено: враг совсем рядом (≤ 900 ед. — почти наверняка в кадре, камера у героя), полоски нет
    if (v.screen.meOnScreen) {
      for (const c of cands) if (!used.has(c) && c.d <= 900) (S.hp.missed++, why('полоска: враг вплотную, полоски нет'), row.bars.push(['miss', c.e.slot, Math.round(c.d)]));
    } else if (cands.some((c) => c.d <= 900)) why('полоска: враг вплотную, а своя полоска не найдена (камера не у героя?)');

    // 4) Сколько врагов рядом (≤ NEAR_UNITS): коуч против STRATZ
    const nearList = enemies.filter((e) => aliveAt(e, t) && posAt(e, t) && dist(posAt(e, t), mePos) <= NEAR_UNITS);
    const trueNear = nearList.length;
    const visNear = nearList.filter((e) => (calNow && markerPixels(frame, calNow, e.slot, posAt(e, t)) >= 50) || [...used].some((c) => c.e === e)).length;
    const coach = nearEnemyCount(v);
    if (coach === trueNear) S.near.ok++;
    else if (coach > trueNear) (S.near.wrong++, why('рядом: коуч насчитал больше, чем есть'));
    else (S.near.missed++, why(coach >= visNear ? 'рядом: меньше, чем есть, — остальные не видны (туман)' : 'рядом: меньше, чем видно на экране'));
    if (coach === visNear) S.nearVis.ok++;
    else if (coach > visNear) S.nearVis.wrong++;
    else S.nearVis.missed++;
    const mapNear = v.enemies.filter((e) => e.alive.value !== false && e.pos.value && e.pos.ageSec !== null && e.pos.ageSec <= 2 && dist(e.pos.value, mePos) <= NEAR_UNITS).length;
    row.near = [coach, trueNear, visNear, mapNear, v.screen.meOnScreen ? v.screen.enemyBars.length : -1];
    row.own = { lvl: body.hero.level, green: hud.healthBars.bars.filter((b) => b.color === 'green').map((b) => [b.level, Math.round(b.confidence * 100) / 100, b.x, b.y, Math.round(b.hpPercent)]), hp: body.hero.health_percent, me: v.screen.meOnScreen };
  }
  out.push(row);
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
const line = (name, s) => {
  const tot = s.ok + s.wrong + s.missed + s.rejected;
  return `| ${name} | ${s.ok} (${pct(s.ok, tot)}) | ${s.wrong} (${pct(s.wrong, tot)}) | ${s.missed} (${pct(s.missed, tot)}) | ${s.rejected} (${pct(s.rejected, tot)}) | ${tot} |`;
};
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)] : null);
console.log(`Матч ${matchId}: кадров в игре ${n}; свой герой GSI↔STRATZ: медиана ${Math.round(med(S.ownErr))} ед., 90% ${Math.round(p90(S.ownErr))}`);
console.log('| Вид | Верно | Неверно | Пропущено | Отклонено | Всего |\n|---|---|---|---|---|---|');
console.log(line('Враги на мини-карте', S.minimap));
console.log(line('Кто жив (верхняя панель, 9 героев)', S.alive));
console.log(line('  из них враги', S.aliveEnemy));
console.log(line('HP видимых врагов (±10%)', S.hp));
console.log(line('Уровень видимых врагов', S.level));
console.log(line('Врагов рядом (≤ 2500 ед.), все', S.near));
console.log(line('Врагов рядом, только видимые', S.nearVis));
console.log(`HP: ошибка медиана ${med(S.hpErr)?.toFixed(1)}%, 90% ${p90(S.hpErr)?.toFixed(1)}%`);
console.log('\nПричины:');
for (const [k, c] of Object.entries(S.why).sort((a, b) => b[1] - a[1])) console.log(`  ${c}\t${k}`);
const outFile = opt('--out');
if (outFile) writeFileSync(outFile, out.map((r) => JSON.stringify(r)).join('\n'));
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ matchId, frames: n, ...S, ownErr: undefined, hpErr: undefined, ownErrMed: med(S.ownErr), hpErrMed: med(S.hpErr), hpErrP90: p90(S.hpErr) }, null, 1));

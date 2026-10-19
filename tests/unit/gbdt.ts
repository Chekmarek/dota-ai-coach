// Градиентный бустинг деревьев решений (логистическая потеря) — своё, без зависимостей. Формат — как читает
// treesProbability (src/core/coach/danger-model.ts): полные двоичные деревья глубины depth, пороги по признакам.
// Ускорение: признаки разбиты на BINS корзин по квантилям, разбиения ищутся по гистограммам.
import { treesProbability, type DangerTrees } from '../../src/core/coach/danger-model.ts';

const BINS = 32;

/** init — продолжить бустинг с готовой модели (дообучение: Турбо с деревьев All Pick) */
export function trainGBDT(X: number[][], Y: number[], opts: { trees?: number; depth?: number; lr?: number; minLeaf?: number; subsample?: number; seed?: number; init?: DangerTrees } = {}): DangerTrees {
  const T = opts.trees ?? 150, D = opts.depth ?? 3, LR = opts.lr ?? 0.1, MIN = opts.minLeaf ?? 200, SUB = opts.subsample ?? 0.5;
  const n = X.length, d = X[0]!.length;
  // Пороги корзин по квантилям каждого признака
  const cuts: number[][] = [];
  const binned: Uint8Array[] = [];
  for (let j = 0; j < d; j++) {
    const sample = Array.from({ length: Math.min(n, 20000) }, (_, k) => X[Math.floor((k * n) / Math.min(n, 20000))]![j]!).sort((a, b) => a - b);
    const c = [...new Set(Array.from({ length: BINS - 1 }, (_, k) => sample[Math.floor(((k + 1) * sample.length) / BINS)]!))];
    cuts.push(c);
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = X[i]![j]!;
      let lo = 0, hi = c.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (x <= c[mid]!) hi = mid;
        else lo = mid + 1;
      }
      b[i] = lo;
    }
    binned.push(b);
  }
  const pos = Y.reduce((a, c) => a + c, 0);
  const bias = opts.init ? opts.init.bias : Math.log((pos + 1) / (n - pos + 1));
  const F = new Float64Array(n).fill(bias);
  if (opts.init) for (let i = 0; i < n; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, treesProbability(opts.init, X[i]!)));
    F[i] = Math.log(p / (1 - p));
  }
  const g = new Float64Array(n), h = new Float64Array(n);
  const nodeOf = new Int32Array(n);
  let s = (opts.seed ?? 1) >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const trees: DangerTrees['trees'] = opts.init ? [...opts.init.trees] : [];
  const nodes = 2 ** D - 1, leaves = 2 ** D;
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < n; i++) {
      const p = 1 / (1 + Math.exp(-F[i]!));
      g[i] = p - Y[i]!;
      h[i] = Math.max(1e-6, p * (1 - p));
    }
    const use = new Uint8Array(n);
    for (let i = 0; i < n; i++) use[i] = rnd() < SUB ? 1 : 0;
    nodeOf.fill(0);
    const f = new Array<number>(nodes).fill(0), thr = new Array<number>(nodes).fill(Infinity);
    for (let depth = 0; depth < D; depth++) {
      const first = 2 ** depth - 1, count = 2 ** depth;
      // Гистограммы градиентов по узлам уровня × признакам × корзинам
      const G = new Float64Array(count * d * BINS), H = new Float64Array(count * d * BINS);
      for (let i = 0; i < n; i++) {
        if (!use[i]) continue;
        const k = nodeOf[i]! - first;
        if (k < 0 || k >= count) continue;
        const base = k * d * BINS;
        for (let j = 0; j < d; j++) {
          const o = base + j * BINS + binned[j]![i]!;
          G[o]! += g[i]!;
          H[o]! += h[i]!;
        }
      }
      for (let k = 0; k < count; k++) {
        let best = 0, bf = 0, bb = BINS - 1;
        for (let j = 0; j < d; j++) {
          const base = k * d * BINS + j * BINS;
          let gt = 0, ht = 0;
          for (let b = 0; b < BINS; b++) (gt += G[base + b]!), (ht += H[base + b]!);
          let gl = 0, hl = 0;
          for (let b = 0; b < cuts[j]!.length; b++) {
            gl += G[base + b]!;
            hl += H[base + b]!;
            const gr = gt - gl, hr = ht - hl;
            if (hl < MIN * 0.05 || hr < MIN * 0.05) continue;
            const gain = (gl * gl) / (hl + 1) + (gr * gr) / (hr + 1) - (gt * gt) / (ht + 1);
            if (gain > best) (best = gain), (bf = j), (bb = b);
          }
        }
        f[first + k] = bf;
        thr[first + k] = best > 0 ? cuts[bf]![bb]! : Infinity;
      }
      for (let i = 0; i < n; i++) {
        const nd = nodeOf[i]!;
        nodeOf[i] = 2 * nd + (X[i]![f[nd]!]! <= thr[nd]! ? 1 : 2);
      }
    }
    const lg = new Float64Array(leaves), lh = new Float64Array(leaves);
    for (let i = 0; i < n; i++) {
      if (!use[i]) continue;
      const l = nodeOf[i]! - nodes;
      lg[l]! += g[i]!;
      lh[l]! += h[i]!;
    }
    const v = Array.from({ length: leaves }, (_, l) => (lh[l]! > 0 ? (-LR * lg[l]!) / (lh[l]! + 1) : 0));
    for (let i = 0; i < n; i++) F[i]! += v[nodeOf[i]! - nodes]!;
    trees.push({ f, t: thr.map((x) => (Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : 1e9)), v: v.map((x) => Math.round(x * 1e5) / 1e5) });
  }
  return { depth: D, bias: opts.init ? bias : Math.round(bias * 1e5) / 1e5, trees };
}

// Логистическая регрессия (Adam, L2) и метрики — общее для обучения моделей коуча (прогноз драк, экзамен).
export type W = { bias: number; w: number[] };

export function trainLR(X: number[][], Y: number[], d: number, init: W | null = null, epochs = 40, l2 = 1e-4, lr = 0.05): W {
  const n = X.length;
  const w = init ? [...init.w] : new Array<number>(d).fill(0);
  const pos = Y.reduce((a, c) => a + c, 0);
  let b = init ? init.bias : Math.log((pos + 1) / (n - pos + 1));
  const m1 = new Array<number>(d + 1).fill(0), m2 = new Array<number>(d + 1).fill(0);
  const batch = 2048;
  let step = 0;
  const order = [...Array(n).keys()];
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (let s = 0; s < n; s += batch) {
      const g = new Array<number>(d + 1).fill(0);
      const e = Math.min(n, s + batch);
      for (let k = s; k < e; k++) {
        const x = X[order[k]!]!;
        let z = b;
        for (let q = 0; q < d; q++) z += w[q]! * x[q]!;
        const err = 1 / (1 + Math.exp(-z)) - Y[order[k]!]!;
        for (let q = 0; q < d; q++) g[q]! += err * x[q]!;
        g[d]! += err;
      }
      step++;
      for (let q = 0; q <= d; q++) {
        const gq = g[q]! / (e - s) + (q < d ? l2 * w[q]! : 0);
        m1[q] = 0.9 * m1[q]! + 0.1 * gq;
        m2[q] = 0.999 * m2[q]! + 0.001 * gq * gq;
        const upd = (lr * (m1[q]! / (1 - 0.9 ** step))) / (Math.sqrt(m2[q]! / (1 - 0.999 ** step)) + 1e-8);
        if (q < d) w[q]! -= upd;
        else b -= upd;
      }
    }
  }
  return { bias: b, w };
}

export const sigmoid = (w: W, x: readonly number[]) => {
  let z = w.bias;
  for (let i = 0; i < x.length; i++) z += w.w[i]! * x[i]!;
  return 1 / (1 + Math.exp(-z));
};

export function auc(p: number[], y: number[]): number | null {
  const idx = [...p.keys()].sort((a, b) => p[a]! - p[b]!);
  let pos = 0, rankSum = 0;
  idx.forEach((i, r) => {
    if (y[i]) (pos++, (rankSum += r + 1));
  });
  const neg = y.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}

/** Честность процентов: по группам 0–10%, 10–20% … — средний прогноз и доля сбывшихся; ECE — среднее отклонение, п.п. */
export function calibrationTable(p: number[], y: number[]) {
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, n: 0, sumP: 0, sumY: 0 }));
  p.forEach((q, i) => {
    const b = bins[Math.min(9, Math.floor(q * 10))]!;
    b.n++;
    b.sumP += q;
    b.sumY += y[i]!;
  });
  const rows = bins.map((b) => ({ range: `${b.from}–${b.to}%`, n: b.n, predicted: b.n ? (100 * b.sumP) / b.n : null, actual: b.n ? (100 * b.sumY) / b.n : null }));
  const total = p.length || 1;
  const ece = rows.reduce((s, r) => s + (r.n ? (r.n / total) * Math.abs(r.predicted! - r.actual!) : 0), 0);
  return { rows, ece };
}

export function seededShuffle<T>(a: T[], seed: number): T[] {
  let s = seed >>> 0 || 1;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

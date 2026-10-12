/** Сравнение версий вида 0.5.0 / v0.5.0 / 0.5.0-beta.1: 1 — a новее, -1 — b новее, 0 — равны */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

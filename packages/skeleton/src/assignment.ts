/**
 * Child-pairing at one hierarchy fork: the cost function both matchers use,
 * the original exact-for-small-fan-out/greedy-beyond matcher
 * (`matchChildren`), and the Kuhn-Munkres optimal assignment that replaced
 * it for the core-label matcher (`assignOptimal`).
 */
import { vdot, vlen } from './math.js';
import type { Vec3 } from './types.js';

/** Cost of matching one source child to one target child, given their already-matched parents: the angle between, plus the relative length difference of, the two parent->child offset vectors. */
export function childCost(offL: Vec3, offB: Vec3): number {
  const lenL = vlen(offL), lenB = vlen(offB);
  if (lenL < 1e-6 && lenB < 1e-6) return 0;
  if (lenL < 1e-6 || lenB < 1e-6) return 2;
  const cos = vdot(offL, offB) / (lenL * lenB);
  return (1 - cos) + 0.5 * (Math.abs(lenL - lenB) / Math.max(lenL, lenB));
}

/** Exact bipartite assignment for small fan-out (which covers every real humanoid joint), cheapest-pair-first GREEDY beyond it. Prefer `assignOptimal` for new code — see its doc for what the greedy tail costs. */
export function matchChildren(costs: number[][]): Array<[number, number]> {
  const nL = costs.length, nB = costs[0]?.length ?? 0;
  if (nL === 0 || nB === 0) return [];
  const n = Math.min(nL, nB);
  if (Math.max(nL, nB) <= 8) {
    const bIdx = [...Array(nB).keys()];
    const lIdx = [...Array(nL).keys()];
    let best: Array<[number, number]> | null = null;
    let bestCost = Infinity;
    if (nL <= nB) {
      const permute = (chosen: number[], remaining: number[]): void => {
        if (chosen.length === n) {
          const cost = chosen.reduce((s, b, i) => s + costs[i]![b]!, 0);
          if (cost < bestCost) { bestCost = cost; best = chosen.map((b, i) => [i, b]); }
          return;
        }
        for (let k = 0; k < remaining.length; k++) permute([...chosen, remaining[k]!], [...remaining.slice(0, k), ...remaining.slice(k + 1)]);
      };
      permute([], bIdx);
    } else {
      const costsT = bIdx.map((_, bi) => costs.map((row) => row[bi]!));
      const permute2 = (chosen: number[], remaining: number[]): void => {
        if (chosen.length === n) {
          const cost = chosen.reduce((s, l, i) => s + costsT[i]![l]!, 0);
          if (cost < bestCost) { bestCost = cost; best = chosen.map((l, i) => [l, i]); }
          return;
        }
        for (let k = 0; k < remaining.length; k++) permute2([...chosen, remaining[k]!], [...remaining.slice(0, k), ...remaining.slice(k + 1)]);
      };
      permute2([], lIdx);
    }
    return best ?? [];
  }
  const usedB = new Set<number>(), usedL = new Set<number>();
  const pairs: Array<[number, number]> = [];
  const flat: Array<{ l: number; b: number; c: number }> = [];
  for (let l = 0; l < nL; l++) for (let b = 0; b < nB; b++) flat.push({ l, b, c: costs[l]![b]! });
  flat.sort((a, b) => a.c - b.c);
  for (const f of flat) {
    if (usedL.has(f.l) || usedB.has(f.b)) continue;
    usedL.add(f.l); usedB.add(f.b);
    pairs.push([f.l, f.b]);
  }
  return pairs;
}

/**
 * Optimal (minimum-total-cost) one-to-one assignment for a rectangular cost
 * matrix — the Kuhn-Munkres / "Hungarian" algorithm with row/column
 * potentials, O(n^2 m). Returns `[rowIndex, colIndex]` pairs, one per row
 * (or per column, whichever side is smaller), sorted by row.
 *
 * **Why this exists.** `matchChildren` above only does an exact assignment
 * for fan-out <= 8 and falls back to a cheapest-pair-first GREEDY sweep
 * beyond that. Real humanoid chest bones routinely exceed that cap (two
 * measured rigs: 15 and 18 children, the extras being cape and decoration
 * leaves), so the one fork that decides neck-vs-clavicle was assigned
 * greedily — and the greedy sweep took source NECK -> target R-CLAVICLE
 * (cost 0.028, because that source neck's length happened to be closer to
 * the target clavicle's length than to the target neck's) before it could
 * consider neck -> neck (cost 0.069). Everything under the head then landed
 * on the wrong side of the body. The optimal assignment (total 0.069 + ~0)
 * beats the greedy one (0.028 + 0.159) by a wide margin: the cost function
 * was never the problem, the assignment was.
 */
export function assignOptimal(costs: readonly (readonly number[])[]): Array<[number, number]> {
  const nL = costs.length, nB = costs[0]?.length ?? 0;
  if (nL === 0 || nB === 0) return [];
  const transpose = nL > nB;
  const n = transpose ? nB : nL, m = transpose ? nL : nB; // n <= m
  const c = (i: number, j: number): number => (transpose ? costs[j]![i]! : costs[i]![j]!);
  const INF = Number.POSITIVE_INFINITY;
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(INF);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0]!;
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = c(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (cur < minv[j]!) { minv[j] = cur; way[j] = j0; }
        if (minv[j]! < delta) { delta = minv[j]!; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]!] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]!; p[j0] = p[j1]!; j0 = j1; } while (j0);
  }
  const pairs: Array<[number, number]> = [];
  for (let j = 1; j <= m; j++) {
    if (p[j]! <= 0) continue;
    const row = p[j]! - 1, col = j - 1;
    pairs.push(transpose ? [col, row] : [row, col]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}

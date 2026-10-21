import { NES_COLORS, SCREEN_W, SCREEN_H, ATTR, BLOCKS_W, BLOCKS_H, NUM_PALETTES } from './nes.js';
import { labOf, dist2 } from './color.js';

const K = NES_COLORS.length;
const NES_LAB = NES_COLORS.map((c) => labOf(...c.rgb));
const NUM_BLOCKS = BLOCKS_W * BLOCKS_H;

export function nearestNes(lab) {
  let best = 0, bestD = Infinity;
  for (let c = 0; c < K; c++) {
    const d = dist2(lab, NES_LAB[c]);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// Summarize each 16x16 block as bins keyed by nearest NES color, holding the pixel
// count and Lab sum. For squared distances, sum_i |x_i - c|^2 = n|mean - c|^2 + const,
// so palette errors can be evaluated exactly per bin instead of per pixel.
function buildBlockBins(labs) {
  const count = new Float64Array(NUM_BLOCKS * K);
  const sum = new Float64Array(NUM_BLOCKS * K * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const p = y * SCREEN_W + x;
      const lab = [labs[p * 3], labs[p * 3 + 1], labs[p * 3 + 2]];
      const b = ((y / ATTR) | 0) * BLOCKS_W + ((x / ATTR) | 0);
      const k = nearestNes(lab);
      count[b * K + k]++;
      const s = (b * K + k) * 3;
      sum[s] += lab[0]; sum[s + 1] += lab[1]; sum[s + 2] += lab[2];
    }
  }
  return { count, sum };
}

// Cost matrix for a (possibly weighted) set of blocks: cost[k*K + c] is the summed
// squared error of mapping every pixel in bin k to NES color c.
function groupCost(bins, blocks, weights) {
  const count = new Float64Array(K);
  const sum = new Float64Array(K * 3);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const w = weights ? weights[i] : 1;
    for (let k = 0; k < K; k++) {
      const n = bins.count[b * K + k];
      if (!n) continue;
      count[k] += n * w;
      const s = (b * K + k) * 3;
      sum[k * 3] += bins.sum[s] * w;
      sum[k * 3 + 1] += bins.sum[s + 1] * w;
      sum[k * 3 + 2] += bins.sum[s + 2] * w;
    }
  }
  const active = [];
  for (let k = 0; k < K; k++) if (count[k] > 0) active.push(k);
  const cost = new Float64Array(K * K);
  for (const k of active) {
    const mean = [sum[k * 3] / count[k], sum[k * 3 + 1] / count[k], sum[k * 3 + 2] / count[k]];
    for (let c = 0; c < K; c++) cost[k * K + c] = count[k] * dist2(mean, NES_LAB[c]);
  }
  return { cost, active };
}

// Exhaustive search over all C(K-1, 3) triples for the three colors that, together
// with the universal background color, minimize the group's error.
function bestTriple({ cost, active }, bg) {
  const cand = [];
  for (let c = 0; c < K; c++) if (c !== bg) cand.push(c);
  const n = active.length;
  const base = new Float64Array(n);
  for (let i = 0; i < n; i++) base[i] = cost[active[i] * K + bg];
  if (n === 0) return { colors: cand.slice(0, 3), err: 0 };

  const mAB = new Float64Array(n);
  let bestErr = Infinity, best = null;
  for (let ia = 0; ia < cand.length; ia++) {
    const a = cand[ia];
    for (let ib = ia + 1; ib < cand.length; ib++) {
      const b = cand[ib];
      for (let i = 0; i < n; i++) {
        const row = active[i] * K;
        mAB[i] = Math.min(base[i], cost[row + a], cost[row + b]);
      }
      for (let ic = ib + 1; ic < cand.length; ic++) {
        const c = cand[ic];
        let e = 0;
        for (let i = 0; i < n && e < bestErr; i++) {
          const v = cost[active[i] * K + c];
          e += v < mAB[i] ? v : mAB[i];
        }
        if (e < bestErr) { bestErr = e; best = [a, b, c]; }
      }
    }
  }
  return { colors: best, err: bestErr };
}

function blockError(bins, b, palette) {
  let e = 0;
  for (let k = 0; k < K; k++) {
    const n = bins.count[b * K + k];
    if (!n) continue;
    const s = (b * K + k) * 3;
    const mean = [bins.sum[s] / n, bins.sum[s + 1] / n, bins.sum[s + 2] / n];
    let m = Infinity;
    for (const c of palette) m = Math.min(m, dist2(mean, NES_LAB[c]));
    e += n * m;
  }
  return e;
}

const ALL_BLOCKS = Array.from({ length: NUM_BLOCKS }, (_, i) => i);

// Lloyd-style clustering of blocks into 4 palettes for a fixed background color.
function optimizeForBg(bins, bg, maxIter = 20) {
  const palettes = [];
  let errs = new Float64Array(NUM_BLOCKS).fill(Infinity);
  // Seeding: the first palette serves the whole image; each next one is fitted to the
  // blocks weighted by how badly the palettes chosen so far serve them.
  for (let p = 0; p < NUM_PALETTES; p++) {
    const weights = p === 0 ? null : Array.from(errs);
    const { colors } = bestTriple(groupCost(bins, ALL_BLOCKS, weights), bg);
    palettes.push([bg, ...colors]);
    for (let b = 0; b < NUM_BLOCKS; b++) errs[b] = Math.min(errs[b], blockError(bins, b, palettes[p]));
  }

  let assign = new Int32Array(NUM_BLOCKS).fill(-1);
  let total = Infinity;
  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Int32Array(NUM_BLOCKS);
    total = 0;
    for (let b = 0; b < NUM_BLOCKS; b++) {
      let best = 0, bestE = Infinity;
      for (let p = 0; p < NUM_PALETTES; p++) {
        const e = blockError(bins, b, palettes[p]);
        if (e < bestE) { bestE = e; best = p; }
      }
      next[b] = best;
      errs[b] = bestE;
      total += bestE;
    }
    if (next.every((v, i) => v === assign[i])) break;
    assign = next;

    for (let p = 0; p < NUM_PALETTES; p++) {
      const members = ALL_BLOCKS.filter((b) => assign[b] === p);
      if (members.length === 0) {
        // Reseed an unused palette from the worst-served block.
        let worst = 0;
        for (let b = 1; b < NUM_BLOCKS; b++) if (errs[b] > errs[worst]) worst = b;
        members.push(worst);
      }
      palettes[p] = [bg, ...bestTriple(groupCost(bins, members), bg).colors];
    }
  }
  return { palettes, assign, total };
}

/**
 * Choose the universal background color and four 4-color palettes, and assign one
 * palette to every 16x16 block. Returns NES_COLORS indices.
 */
export function choosePalettes(labs, { bg = null, bgCandidates = 6 } = {}) {
  const bins = buildBlockBins(labs);
  let candidates;
  if (bg !== null) {
    candidates = [bg];
  } else {
    const global = new Float64Array(K);
    for (let i = 0; i < bins.count.length; i++) global[i % K] += bins.count[i];
    candidates = [...global.keys()].filter((k) => global[k] > 0)
      .sort((a, b) => global[b] - global[a]).slice(0, bgCandidates);
  }

  let best = null;
  for (const c of candidates) {
    const r = optimizeForBg(bins, c);
    if (!best || r.total < best.total) best = { ...r, bg: c };
  }

  // Sort each palette's three colors dark-to-light for readable output.
  best.palettes = best.palettes.map(([b, ...rest]) => [b, ...rest.sort((x, y) => NES_LAB[x][0] - NES_LAB[y][0])]);
  return best;
}

export { NES_LAB };

import { SCREEN_W, MAP_W, MAP_H, TILE } from './nes.js';
import { dist2 } from './color.js';
import { NES_LAB } from './palettes.js';
import { blockOf } from './render.js';

const NT = MAP_W * MAP_H; // 960 nametable cells
const PX = TILE * TILE; // 64 pixels per tile

const keyOf = (pat) => String.fromCharCode(...pat);

/**
 * Reduce the 960 nametable cells to at most `maxTiles` distinct 2-bit patterns.
 * Background tiles cannot be flipped, so only exact pattern matches are free; beyond
 * that we cluster cells (k-medoids seeding + Lloyd refinement). The error of drawing a
 * cell with a pattern is measured in Lab *through that cell's own palette*, and the
 * best pattern for a cluster decomposes per pixel, so each update step is exact.
 */
export function reduceTiles(indices, targets, palettes, assign, maxTiles) {
  const pats = [];
  const cost = new Float32Array(NT * PX * 4);
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const t = ty * MAP_W + tx;
      const pal = palettes[assign[blockOf(tx * TILE, ty * TILE)]];
      const pat = new Uint8Array(PX);
      for (let i = 0; i < PX; i++) {
        const p = (ty * TILE + (i >> 3)) * SCREEN_W + tx * TILE + (i & 7);
        pat[i] = indices[p];
        const target = [targets[p * 3], targets[p * 3 + 1], targets[p * 3 + 2]];
        for (let v = 0; v < 4; v++) cost[(t * PX + i) * 4 + v] = dist2(target, NES_LAB[pal[v]]);
      }
      pats.push(pat);
    }
  }

  const tileCost = (t, pat) => {
    let e = 0;
    const o = t * PX * 4;
    for (let i = 0; i < PX; i++) e += cost[o + i * 4 + pat[i]];
    return e;
  };

  const uniq = new Map();
  pats.forEach((p, t) => {
    const k = keyOf(p);
    if (!uniq.has(k)) uniq.set(k, []);
    uniq.get(k).push(t);
  });

  let centroids;
  let map = new Int32Array(NT);
  let reduced = false;

  if (uniq.size <= maxTiles) {
    centroids = pats;
    for (let t = 0; t < NT; t++) map[t] = t;
  } else {
    reduced = true;
    const own = pats.map((p, t) => tileCost(t, p));
    const cur = new Float64Array(NT).fill(Infinity);
    centroids = [];
    const add = (pat) => {
      centroids.push(Uint8Array.from(pat));
      for (let t = 0; t < NT; t++) cur[t] = Math.min(cur[t], tileCost(t, pat));
    };
    const worst = () => {
      let w = 0;
      for (let t = 1; t < NT; t++) if (cur[t] - own[t] > cur[w] - own[w]) w = t;
      return w;
    };

    // Seed with the most common pattern, then repeatedly with the worst-served cell.
    let common = null;
    for (const members of uniq.values()) if (!common || members.length > common.length) common = members;
    add(pats[common[0]]);
    while (centroids.length < maxTiles) add(pats[worst()]);

    for (let iter = 0; iter < 12; iter++) {
      let changed = false;
      for (let t = 0; t < NT; t++) {
        let best = 0, bestE = Infinity;
        for (let j = 0; j < centroids.length; j++) {
          const e = tileCost(t, centroids[j]);
          if (e < bestE) { bestE = e; best = j; }
        }
        if (map[t] !== best || iter === 0) changed = true;
        map[t] = best;
        cur[t] = bestE;
      }
      if (!changed) break;

      const members = centroids.map(() => []);
      for (let t = 0; t < NT; t++) members[map[t]].push(t);
      for (let j = 0; j < centroids.length; j++) {
        if (members[j].length === 0) {
          const w = worst();
          centroids[j] = Uint8Array.from(pats[w]);
          continue;
        }
        const pat = new Uint8Array(PX);
        for (let i = 0; i < PX; i++) {
          let best = 0, bestE = Infinity;
          for (let v = 0; v < 4; v++) {
            let e = 0;
            for (const t of members[j]) e += cost[(t * PX + i) * 4 + v];
            if (e < bestE) { bestE = e; best = v; }
          }
          pat[i] = best;
        }
        centroids[j] = pat;
      }
    }
    // Final assignment against the refined centroids.
    for (let t = 0; t < NT; t++) {
      let best = 0, bestE = Infinity;
      for (let j = 0; j < centroids.length; j++) {
        const e = tileCost(t, centroids[j]);
        if (e < bestE) { bestE = e; best = j; }
      }
      map[t] = best;
    }
  }

  // Compact: drop unused/duplicate patterns, numbering tiles in nametable order.
  const tiles = [];
  const ids = new Map();
  const nametable = new Uint8Array(NT);
  for (let t = 0; t < NT; t++) {
    const pat = centroids[map[t]];
    const k = keyOf(pat);
    if (!ids.has(k)) { ids.set(k, tiles.length); tiles.push(pat); }
    nametable[t] = ids.get(k);
  }
  return { tiles, nametable, uniqueBefore: uniq.size, reduced };
}

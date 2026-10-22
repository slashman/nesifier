import { NES_COLORS, SCREEN_W, SCREEN_H, TILE } from './nes.js';
import { dist2 } from './color.js';
import { NES_LAB, nearestNes } from './palettes.js';

export const MAX_SPRITES = 64;
export const SPRITES_PER_LINE = 8;
const SPRITE_PALETTES = 4;
const K = NES_COLORS.length;
const N = SCREEN_W * SCREEN_H;
// Sprites appear one line below their OAM Y, so line 0 can never show a sprite. Line 1
// (OAM Y = 0) is legal, but some emulators (jsnes) skip it, so start at line 2.
const MIN_Y = 2;
const STEP = 2; // candidate positions are tested every 2 pixels
const RING = 4; // margin around a window used to tell local detail from broad error

/**
 * Place up to `max` 8x8 sprites where they most improve on the background.
 * Sprite color 0 is transparent, so each sprite pixel either shows the background
 * or one of its palette's 3 colors, whichever is closer to the source.
 *
 * @param targets Lab of the source image per pixel
 * @param bgLabs  Lab of the rendered background per pixel
 * @returns { palettes: [4][3] NES_COLORS indices, sprites: [{ x, y, palette, pattern }] }
 */
export function placeSprites(targets, bgLabs, max = MAX_SPRITES) {
  const target = (p) => [targets[p * 3], targets[p * 3 + 1], targets[p * 3 + 2]];
  const bgErr = new Float64Array(N);
  const ideal = new Float64Array(N); // what a free choice of NES color could save
  const nearest = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const t = target(p);
    bgErr[p] = dist2(t, [bgLabs[p * 3], bgLabs[p * 3 + 1], bgLabs[p * 3 + 2]]);
    nearest[p] = nearestNes(t);
    ideal[p] = Math.max(0, bgErr[p] - dist2(t, NES_LAB[nearest[p]]));
  }

  // First guess at where sprites help, before palettes exist: the ideal savings.
  let windows = selectWindows([ideal], max).map((w) => ({ ...w, palette: 0 }));
  if (windows.length === 0) return { palettes: [], sprites: [] };

  let palettes = fitPalettes(windows, target, bgErr, nearest, ideal);
  for (let round = 0; round < 3; round++) {
    // With real palettes, measure each pixel's actual saving per palette and re-place.
    const gains = palettes.map((pal) => paletteGain(pal, target, bgErr));
    windows = selectWindows(gains, max);
    if (windows.length === 0) return { palettes: [], sprites: [] };
    palettes = fitPalettes(windows, target, bgErr, nearest, ideal, palettes);
  }

  const gains = palettes.map((pal) => paletteGain(pal, target, bgErr));
  windows = selectWindows(gains, max);
  const sprites = windows.map(({ x, y, palette }) => {
    const pal = palettes[palette];
    const pattern = new Uint8Array(TILE * TILE);
    for (let i = 0; i < 64; i++) {
      const p = (y + (i >> 3)) * SCREEN_W + x + (i & 7);
      const t = target(p);
      let best = 0, bestE = bgErr[p];
      for (let v = 0; v < 3; v++) {
        const e = dist2(t, NES_LAB[pal[v]]);
        if (e < bestE) { bestE = e; best = v + 1; }
      }
      pattern[i] = best;
    }
    return { x, y, palette, pattern };
  });
  return { palettes, sprites: sprites.filter((s) => s.pattern.some((v) => v)) };
}

// Per-pixel saving if a sprite with this palette covered it (0 where the background wins).
function paletteGain(pal, target, bgErr) {
  const g = new Float64Array(N);
  for (let p = 0; p < N; p++) {
    if (bgErr[p] === 0) continue;
    const t = target(p);
    let m = bgErr[p];
    for (const c of pal) m = Math.min(m, dist2(t, NES_LAB[c]));
    g[p] = bgErr[p] - m;
  }
  return g;
}

// Greedy placement: highest-scoring 8x8 windows first, never overlapping, never more
// than 8 on any scanline. `gainMaps` has one map per palette; each window takes its best.
// A window scores its gain minus what the same palette would gain in the ring around
// it: fixing an 8x8 square inside a broad area of error leaves a visible box, while
// fixing a small detail does not.
function selectWindows(gainMaps, max) {
  const sums = gainMaps.map(integral);
  const cands = [];
  for (let y = MIN_Y; y <= SCREEN_H - TILE; y += STEP) {
    for (let x = 0; x <= SCREEN_W - TILE; x += STEP) {
      let best = 0, palette = 0;
      sums.forEach((s, i) => {
        const inside = boxSum(s, x, y, TILE, TILE);
        const x0 = Math.max(0, x - RING), y0 = Math.max(0, y - RING);
        const x1 = Math.min(SCREEN_W, x + TILE + RING), y1 = Math.min(SCREEN_H, y + TILE + RING);
        const ringArea = (x1 - x0) * (y1 - y0) - TILE * TILE;
        const ring = boxSum(s, x0, y0, x1 - x0, y1 - y0) - inside;
        const v = inside - (ring / ringArea) * TILE * TILE;
        if (v > best) { best = v; palette = i; }
      });
      if (best > 0) cands.push({ x, y, palette, gain: best });
    }
  }
  cands.sort((a, b) => b.gain - a.gain);

  const taken = new Uint8Array(N);
  const perLine = new Uint8Array(SCREEN_H);
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= max) break;
    let ok = true;
    for (let dy = 0; dy < TILE && ok; dy++) {
      if (perLine[c.y + dy] >= SPRITES_PER_LINE) ok = false;
      for (let dx = 0; dx < TILE && ok; dx++) if (taken[(c.y + dy) * SCREEN_W + c.x + dx]) ok = false;
    }
    if (!ok) continue;
    for (let dy = 0; dy < TILE; dy++) {
      perLine[c.y + dy]++;
      taken.fill(1, (c.y + dy) * SCREEN_W + c.x, (c.y + dy) * SCREEN_W + c.x + TILE);
    }
    chosen.push(c);
  }
  return chosen;
}

function integral(map) {
  const W = SCREEN_W + 1;
  const s = new Float64Array(W * (SCREEN_H + 1));
  for (let y = 0; y < SCREEN_H; y++) {
    let row = 0;
    for (let x = 0; x < SCREEN_W; x++) {
      row += map[y * SCREEN_W + x];
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row;
    }
  }
  return s;
}

function boxSum(s, x, y, w, h) {
  const W = SCREEN_W + 1;
  return s[(y + h) * W + x + w] - s[y * W + x + w] - s[(y + h) * W + x] + s[y * W + x];
}

// Fit 4 palettes of 3 colors to the chosen windows (Lloyd-style), evaluating every
// pixel exactly: a pixel costs the closer of the background and the palette's colors.
function fitPalettes(windows, target, bgErr, nearest, ideal, start = null) {
  const pixelsOf = (w) => {
    const out = [];
    for (let dy = 0; dy < TILE; dy++) for (let dx = 0; dx < TILE; dx++) out.push((w.y + dy) * SCREEN_W + w.x + dx);
    return out;
  };
  const winPixels = windows.map(pixelsOf);

  // Candidate colors: the most useful nearest-NES colors among the covered pixels.
  const weight = new Float64Array(K);
  for (const px of winPixels) for (const p of px) weight[nearest[p]] += ideal[p];
  const cand = [...weight.keys()].filter((c) => weight[c] > 0).sort((a, b) => weight[b] - weight[a]).slice(0, 24);
  while (cand.length < 3) cand.push([...Array(K).keys()].find((c) => !cand.includes(c)));

  // cost[j][c] for each covered pixel j and candidate color c
  const fit = (pixels, pixWeights) => {
    const n = pixels.length;
    const base = new Float64Array(n), cost = new Float64Array(n * cand.length);
    pixels.forEach((p, j) => {
      const w = pixWeights ? pixWeights[j] : 1;
      base[j] = bgErr[p] * w;
      const t = target(p);
      cand.forEach((c, k) => { cost[j * cand.length + k] = dist2(t, NES_LAB[c]) * w; });
    });
    let best = null, bestE = Infinity;
    const mAB = new Float64Array(n);
    const C = cand.length;
    for (let a = 0; a < C; a++) {
      for (let b = a + 1; b < C; b++) {
        for (let j = 0; j < n; j++) mAB[j] = Math.min(base[j], cost[j * C + a], cost[j * C + b]);
        for (let c = b + 1; c < C; c++) {
          let e = 0;
          for (let j = 0; j < n && e < bestE; j++) { const v = cost[j * C + c]; e += v < mAB[j] ? v : mAB[j]; }
          if (e < bestE) { bestE = e; best = [cand[a], cand[b], cand[c]]; }
        }
      }
    }
    return best;
  };
  const windowErr = (px, pal) => {
    let e = 0;
    for (const p of px) {
      const t = target(p);
      let m = bgErr[p];
      for (const c of pal) m = Math.min(m, dist2(t, NES_LAB[c]));
      e += m;
    }
    return e;
  };

  let palettes = start ? start.map((p) => [...p]) : [];
  if (!start) {
    // Seed like the background: first palette for everything, then for what's left.
    const errs = winPixels.map((px) => px.reduce((s, p) => s + bgErr[p], 0));
    for (let i = 0; i < SPRITE_PALETTES; i++) {
      const pixels = [], weights = [];
      winPixels.forEach((px, w) => px.forEach((p) => { pixels.push(p); weights.push(errs[w]); }));
      const pal = fit(pixels, i === 0 ? null : weights);
      palettes.push(pal);
      winPixels.forEach((px, w) => { errs[w] = Math.min(errs[w], windowErr(px, pal)); });
    }
  }

  for (let iter = 0; iter < 6; iter++) {
    const groups = palettes.map(() => []);
    winPixels.forEach((px, w) => {
      let best = 0, bestE = Infinity;
      palettes.forEach((pal, i) => { const e = windowErr(px, pal); if (e < bestE) { bestE = e; best = i; } });
      groups[best].push(w);
    });
    const next = groups.map((g, i) => (g.length ? fit(g.flatMap((w) => winPixels[w])) : palettes[i]));
    // An unused or duplicate palette is wasted: refit it to the worst-served windows.
    const errs = winPixels.map((px) => Math.min(...next.map((pal) => windowErr(px, pal))));
    for (let i = 0; i < next.length; i++) {
      const dupe = next.findIndex((p, j) => j < i && p.join() === next[i].join()) >= 0;
      if (!dupe && groups[i].length) continue;
      const worst = [...errs.keys()].sort((a, b) => errs[b] - errs[a]).slice(0, Math.max(1, winPixels.length >> 3));
      next[i] = fit(worst.flatMap((w) => winPixels[w]));
      worst.forEach((w) => { errs[w] = Math.min(errs[w], windowErr(winPixels[w], next[i])); });
    }
    if (next.every((p, i) => p.join() === palettes[i].join())) break;
    palettes = next;
  }
  return palettes;
}

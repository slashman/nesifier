import { NES_COLORS, SCREEN_W, SCREEN_H, ATTR, BLOCKS_W } from './nes.js';
import { labOf, dist2 } from './color.js';
import { NES_LAB } from './palettes.js';

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export const blockOf = (x, y) => ((y / ATTR) | 0) * BLOCKS_W + ((x / ATTR) | 0);

function nearestInPalette(lab, palette) {
  let best = 0, bestD = Infinity;
  for (let v = 0; v < palette.length; v++) {
    const d = dist2(lab, NES_LAB[palette[v]]);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * Map every pixel to a 2-bit index into its block's palette.
 * Returns { indices, targets } where targets holds the Lab color each pixel should
 * ideally keep (the source color, or the dithered choice when dithering).
 */
export function renderIndices(rgb, labs, palettes, assign, { dither = 'none', strength = 0.75 } = {}) {
  const N = SCREEN_W * SCREEN_H;
  const indices = new Uint8Array(N);
  const paletteAt = (x, y) => palettes[assign[blockOf(x, y)]];

  if (dither === 'none') {
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const p = y * SCREEN_W + x;
        indices[p] = nearestInPalette([labs[p * 3], labs[p * 3 + 1], labs[p * 3 + 2]], paletteAt(x, y));
      }
    }
    return { indices, targets: labs };
  }

  if (dither === 'ordered') {
    const amp = 64 * strength;
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const p = y * SCREEN_W + x;
        const t = ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * amp;
        const lab = labOf(clamp(rgb[p * 3] + t), clamp(rgb[p * 3 + 1] + t), clamp(rgb[p * 3 + 2] + t));
        indices[p] = nearestInPalette(lab, paletteAt(x, y));
      }
    }
  } else if (dither === 'fs') {
    // Serpentine Floyd-Steinberg; each pixel can only pick from its own block's palette.
    const buf = Float32Array.from(rgb);
    for (let y = 0; y < SCREEN_H; y++) {
      const ltr = (y & 1) === 0;
      for (let i = 0; i < SCREEN_W; i++) {
        const x = ltr ? i : SCREEN_W - 1 - i;
        const p = y * SCREEN_W + x;
        const r = clamp(buf[p * 3]), g = clamp(buf[p * 3 + 1]), b = clamp(buf[p * 3 + 2]);
        const palette = paletteAt(x, y);
        const v = nearestInPalette(labOf(r, g, b), palette);
        indices[p] = v;
        const out = NES_COLORS[palette[v]].rgb;
        const err = [(r - out[0]) * strength, (g - out[1]) * strength, (b - out[2]) * strength];
        const dx = ltr ? 1 : -1;
        const spread = (xx, yy, w) => {
          if (xx < 0 || xx >= SCREEN_W || yy >= SCREEN_H) return;
          const q = (yy * SCREEN_W + xx) * 3;
          buf[q] += err[0] * w; buf[q + 1] += err[1] * w; buf[q + 2] += err[2] * w;
        };
        spread(x + dx, y, 7 / 16);
        spread(x - dx, y + 1, 3 / 16);
        spread(x, y + 1, 5 / 16);
        spread(x + dx, y + 1, 1 / 16);
      }
    }
  } else {
    throw new Error(`Unknown dither mode: ${dither}`);
  }

  const targets = new Float32Array(N * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const p = y * SCREEN_W + x;
      targets.set(NES_LAB[paletteAt(x, y)[indices[p]]], p * 3);
    }
  }
  return { indices, targets };
}

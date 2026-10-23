// Browser-safe core: conversion, exports, ROM building and checking. Everything here
// works on plain typed arrays; src/index.js adds Node file and image I/O on top.
import { NES_COLORS, SCREEN_W, SCREEN_H, TILE, MAP_W, MAX_TILES, hexToRgb } from './nes.js';
import { labOf, labToRgb } from './color.js';
import { choosePalettes, nearestNes } from './palettes.js';
import { renderIndices, blockOf } from './render.js';
import { reduceTiles } from './tiles.js';
import { placeSprites, MAX_SPRITES } from './sprites.js';

export { toChr, toNametable, toPal, toOam, toJson } from './export.js';
export { toRom } from './rom.js';
export { verify } from './verify.js';
export { embedText, readText } from './pngtext.js';
export { NES_COLORS, SCREEN_W, SCREEN_H } from './nes.js';

export const LAYOUT_KEY = 'nesifier-layout';

// Horizontal stretch factors for showing the 256x240 screen the way a TV did.
export const ASPECTS = {
  square: 1,
  ntsc: 8 / 7, // NTSC pixel aspect ratio
  '4:3': 4 / 3 / (SCREEN_W / SCREEN_H), // whole frame stretched to 4:3 (320x240)
};

/**
 * Where a w x h source lands on the 256x240 screen: crop the source to (sx, sy, sw, sh)
 * and scale that into (dx, dy, dw, dh), padding the rest. With `warp` (an ASPECTS key)
 * the image is fitted to the frame as the TV shows it (256*k x 240) and squeezed
 * horizontally into 256x240, so it looks undistorted once the display stretches it.
 */
export function fitPlan(w, h, { fit = 'cover', warp = 'square' } = {}) {
  const k = ASPECTS[warp];
  const full = { sx: 0, sy: 0, sw: w, sh: h, dx: 0, dy: 0, dw: SCREEN_W, dh: SCREEN_H };
  if (fit === 'fill') return full;
  const frame = (SCREEN_W * k) / SCREEN_H; // displayed aspect ratio
  if (fit === 'cover') {
    const sw = Math.min(w, Math.round(h * frame)), sh = Math.min(h, Math.round(w / frame));
    return { ...full, sx: (w - sw) >> 1, sy: (h - sh) >> 1, sw, sh };
  }
  const s = Math.min((SCREEN_W * k) / w, SCREEN_H / h);
  const dw = Math.min(SCREEN_W, Math.max(1, Math.round((w * s) / k)));
  const dh = Math.min(SCREEN_H, Math.max(1, Math.round(h * s)));
  return { ...full, dx: (SCREEN_W - dw) >> 1, dy: (SCREEN_H - dh) >> 1, dw, dh };
}

/** Scale lightness and chroma, like sharp's modulate({ brightness, saturation }). */
export function modulate(rgb, { saturation = 1, brightness = 1 } = {}) {
  if (saturation === 1 && brightness === 1) return rgb;
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const [L, a, b] = labOf(rgb[i], rgb[i + 1], rgb[i + 2]);
    out.set(labToRgb(L * brightness, a * saturation, b * saturation), i);
  }
  return out;
}

/**
 * Convert a 256x240 RGB buffer into NES background data and a preview image.
 * Options: dither ('none' | 'ordered' | 'fs'), strength, bg (hex string),
 * bgCandidates, maxTiles, sprites (how many 8x8 sprites to add on top, 0-64).
 */
export function nesify(rgb, opts = {}) {
  const { dither = 'none', strength = 0.75, maxTiles = MAX_TILES, bgCandidates = 6, sprites: maxSprites = 0 } = opts;
  const N = SCREEN_W * SCREEN_H;
  const labs = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) labs.set(labOf(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]), p * 3);

  const bg = opts.bg ? nearestNes(labOf(...hexToRgb(opts.bg))) : null;
  const { palettes, assign } = choosePalettes(labs, { bg, bgCandidates });
  const { indices, targets } = renderIndices(rgb, labs, palettes, assign, { dither, strength });
  const { tiles, nametable, uniqueBefore, reduced } = reduceTiles(indices, targets, palettes, assign, Math.min(maxTiles, MAX_TILES));

  // Rebuild the screen exactly as the PPU would draw it: nametable -> pattern -> palette.
  const out = new Uint8Array(N * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const pat = tiles[nametable[((y / TILE) | 0) * MAP_W + ((x / TILE) | 0)]];
      const v = pat[(y % TILE) * TILE + (x % TILE)];
      out.set(NES_COLORS[palettes[assign[blockOf(x, y)]][v]].rgb, (y * SCREEN_W + x) * 3);
    }
  }

  // Sprites go where the background is furthest from the source, drawn in front of it.
  let spritePalettes = [], sprites = [];
  if (maxSprites > 0) {
    const bgLabs = new Float32Array(N * 3);
    for (let p = 0; p < N; p++) bgLabs.set(labOf(out[p * 3], out[p * 3 + 1], out[p * 3 + 2]), p * 3);
    ({ palettes: spritePalettes, sprites } = placeSprites(labs, bgLabs, Math.min(maxSprites, MAX_SPRITES)));
    for (const s of sprites) {
      for (let i = 0; i < 64; i++) {
        if (!s.pattern[i]) continue;
        const p = (s.y + (i >> 3)) * SCREEN_W + s.x + (i & 7);
        out.set(NES_COLORS[spritePalettes[s.palette][s.pattern[i] - 1]].rgb, p * 3);
      }
    }
  }

  // Sprite patterns live in the second pattern table; identical patterns share a tile.
  const spriteTiles = [];
  const tileIds = new Map();
  for (const s of sprites) {
    const key = s.pattern.join('');
    if (!tileIds.has(key)) { tileIds.set(key, spriteTiles.length); spriteTiles.push(s.pattern); }
    s.tile = tileIds.get(key);
  }

  // Palette arrangement as hex colors, for savePng to embed so `nesifier check` can verify it.
  const hex = (c) => NES_COLORS[c].hex;
  const layout = { palettes: palettes.map((p) => p.map(hex)), assign: [...assign] };
  if (sprites.length) {
    layout.sprites = {
      palettes: spritePalettes.map((p) => p.map(hex)),
      list: sprites.map((s) => ({ x: s.x, y: s.y, palette: s.palette, pattern: s.pattern.join('') })),
    };
  }
  return { rgb: out, palettes, assign, tiles, nametable, uniqueBefore, reduced, layout, spritePalettes, sprites, spriteTiles };
}

/**
 * The screen as a viewer would see it: `scale` enlarges with sharp pixels, `aspect`
 * stretches horizontally like a TV, and `scanlines` (0-1) darkens the last line of
 * every NES line. Returns { data: RGB bytes, width, height }.
 */
export function renderPreview(rgb, { scale = 1, aspect = 'square', scanlines = 0 } = {}) {
  const w = SCREEN_W * scale, h = SCREEN_H * scale;
  let data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const keep = scanlines > 0 && y % scale === scale - 1 ? 1 - scanlines : 1;
    for (let x = 0; x < w; x++) {
      const s = (((y / scale) | 0) * SCREEN_W + ((x / scale) | 0)) * 3, o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) data[o + c] = Math.round(rgb[s + c] * keep);
    }
  }

  // Stretch horizontally only, with linear filtering like a CRT's analog signal, so
  // pixel columns don't come out uneven and the scanlines stay sharp.
  const outW = Math.round(w * ASPECTS[aspect]);
  if (outW !== w) {
    const src = data;
    data = new Uint8Array(outW * h * 3);
    for (let x = 0; x < outW; x++) {
      const u = Math.min(Math.max(((x + 0.5) * w) / outW - 0.5, 0), w - 1);
      const x0 = Math.floor(u), x1 = Math.min(x0 + 1, w - 1), f = u - x0;
      for (let y = 0; y < h; y++) {
        const a = (y * w + x0) * 3, b = (y * w + x1) * 3, o = (y * outW + x) * 3;
        for (let c = 0; c < 3; c++) data[o + c] = Math.round(src[a + c] * (1 - f) + src[b + c] * f);
      }
    }
  }
  return { data, width: outW, height: h };
}

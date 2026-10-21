import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { NES_COLORS, SCREEN_W, SCREEN_H, TILE, MAP_W, MAX_TILES, hexToRgb } from './nes.js';
import { labOf } from './color.js';
import { choosePalettes, nearestNes } from './palettes.js';
import { renderIndices, blockOf } from './render.js';
import { reduceTiles } from './tiles.js';
import { embedText } from './pngtext.js';

// Public API: everything a library user needs is importable from 'nesifier'.
export { toChr, toNametable, toPal, toJson } from './export.js';
export { toRom } from './rom.js';
export { verify } from './verify.js';
export { NES_COLORS } from './nes.js';

export const LAYOUT_KEY = 'nesifier-layout';

// Horizontal stretch factors for showing the 256x240 screen the way a TV did.
export const ASPECTS = {
  square: 1,
  ntsc: 8 / 7, // NTSC pixel aspect ratio
  '4:3': 4 / 3 / (SCREEN_W / SCREEN_H), // whole frame stretched to 4:3 (320x240)
};

/**
 * Load and fit an image to 256x240. With `warp` (an ASPECTS key), the image is fitted to
 * the frame as the TV shows it (256*k x 240) and then squeezed horizontally into
 * 256x240, so it looks undistorted once the display stretches it back by k.
 */
export async function loadImage(input, { fit = 'cover', kernel = 'lanczos3', fill = '#000000', saturation = 1, brightness = 1, warp = 'square' } = {}) {
  const k = ASPECTS[warp];
  let img = sharp(input).modulate({ saturation, brightness });

  if (k === 1 || fit === 'fill') {
    img = img.resize(SCREEN_W, SCREEN_H, { fit, kernel, background: fill });
  } else {
    // Both branches resample once: crop or scale in source space, then one non-uniform resize.
    const { width: w, height: h } = await sharp(input).metadata();
    const frame = (SCREEN_W * k) / SCREEN_H; // displayed aspect ratio
    if (fit === 'cover') {
      const cw = Math.min(w, Math.round(h * frame)), ch = Math.min(h, Math.round(w / frame));
      img = img
        .extract({ left: (w - cw) >> 1, top: (h - ch) >> 1, width: cw, height: ch })
        .resize(SCREEN_W, SCREEN_H, { fit: 'fill', kernel });
    } else {
      const s = Math.min((SCREEN_W * k) / w, SCREEN_H / h);
      const rw = Math.min(SCREEN_W, Math.max(1, Math.round((w * s) / k)));
      const rh = Math.min(SCREEN_H, Math.max(1, Math.round(h * s)));
      const left = (SCREEN_W - rw) >> 1, top = (SCREEN_H - rh) >> 1;
      img = img
        .resize(rw, rh, { fit: 'fill', kernel })
        .extend({ left, right: SCREEN_W - rw - left, top, bottom: SCREEN_H - rh - top, background: fill });
    }
  }

  const { data } = await img
    .flatten({ background: fill })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

/**
 * Convert a 256x240 RGB buffer into NES background data and a preview image.
 * Options: dither ('none' | 'ordered' | 'fs'), strength, bg (hex string),
 * bgCandidates, maxTiles.
 */
export function nesify(rgb, opts = {}) {
  const { dither = 'none', strength = 0.75, maxTiles = MAX_TILES, bgCandidates = 6 } = opts;
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
  // Palette arrangement as hex colors, for savePng to embed so `nesifier check` can verify it.
  const layout = { palettes: palettes.map((p) => p.map((c) => NES_COLORS[c].hex)), assign: [...assign] };
  return { rgb: out, palettes, assign, tiles, nametable, uniqueBefore, reduced, layout };
}

/**
 * Write the preview PNG. Only `scale` 1 with square aspect and no scanlines is a
 * pixel-exact NES screen; the CRT options are for viewing. A `layout`
 * ({ palettes, assign }) is embedded as a tEXt chunk for `nesifier check`.
 */
export async function savePng(rgb, path, { scale = 1, aspect = 'square', scanlines = 0, layout = null } = {}) {
  const w = SCREEN_W * scale, h = SCREEN_H * scale;
  let img = sharp(Buffer.from(rgb), { raw: { width: SCREEN_W, height: SCREEN_H, channels: 3 } });
  if (scale > 1) img = img.resize(w, h, { kernel: 'nearest' });

  if (scanlines > 0) {
    // Darken the last output line of every NES scanline.
    const buf = await img.raw().toBuffer();
    const keep = 1 - scanlines;
    for (let y = scale - 1; y < h; y += scale) {
      for (let i = y * w * 3; i < (y + 1) * w * 3; i++) buf[i] = Math.round(buf[i] * keep);
    }
    img = sharp(buf, { raw: { width: w, height: h, channels: 3 } });
  }

  // Stretch horizontally only, with linear filtering like a CRT's analog signal, so
  // pixel columns don't come out uneven. Done by hand because libvips also filters
  // vertically, which would smear the scanlines.
  const outW = Math.round(w * ASPECTS[aspect]);
  if (outW !== w) {
    const src = await img.raw().toBuffer();
    const dst = Buffer.alloc(outW * h * 3);
    for (let x = 0; x < outW; x++) {
      const u = Math.min(Math.max(((x + 0.5) * w) / outW - 0.5, 0), w - 1);
      const x0 = Math.floor(u), x1 = Math.min(x0 + 1, w - 1), f = u - x0;
      for (let y = 0; y < h; y++) {
        const a = (y * w + x0) * 3, b = (y * w + x1) * 3, o = (y * outW + x) * 3;
        for (let c = 0; c < 3; c++) dst[o + c] = Math.round(src[a + c] * (1 - f) + src[b + c] * f);
      }
    }
    img = sharp(dst, { raw: { width: outW, height: h, channels: 3 } });
  }

  let png = await img.png({ palette: false }).toBuffer();
  if (layout) png = embedText(png, LAYOUT_KEY, JSON.stringify(layout));
  await writeFile(path, png);
  return { width: outW, height: h };
}

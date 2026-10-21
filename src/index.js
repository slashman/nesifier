import sharp from 'sharp';
import { NES_COLORS, SCREEN_W, SCREEN_H, TILE, MAP_W, MAX_TILES, hexToRgb } from './nes.js';
import { labOf } from './color.js';
import { choosePalettes, nearestNes } from './palettes.js';
import { renderIndices, blockOf } from './render.js';
import { reduceTiles } from './tiles.js';

export async function loadImage(input, { fit = 'cover', kernel = 'lanczos3', fill = '#000000', saturation = 1, brightness = 1 } = {}) {
  const { data } = await sharp(input)
    .modulate({ saturation, brightness })
    .resize(SCREEN_W, SCREEN_H, { fit, kernel, background: fill })
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
  return { rgb: out, palettes, assign, tiles, nametable, uniqueBefore, reduced };
}

export async function savePng(rgb, path, scale = 1) {
  let img = sharp(Buffer.from(rgb), { raw: { width: SCREEN_W, height: SCREEN_H, channels: 3 } });
  if (scale > 1) img = img.resize(SCREEN_W * scale, SCREEN_H * scale, { kernel: 'nearest' });
  await img.png({ palette: false }).toFile(path);
}

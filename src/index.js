// Node entry point: the browser-safe core plus file and image I/O through sharp.
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { SCREEN_W, SCREEN_H } from './nes.js';
import { fitPlan, renderPreview, embedText, LAYOUT_KEY } from './core.js';

export * from './core.js';

/**
 * Load and fit an image to 256x240 (see fitPlan). `kernel` is a sharp resize kernel;
 * `fill` pads `contain` fits and replaces transparency.
 */
export async function loadImage(input, { fit = 'cover', kernel = 'lanczos3', fill = '#000000', saturation = 1, brightness = 1, warp = 'square' } = {}) {
  const { width, height } = await sharp(input).metadata();
  const { sx, sy, sw, sh, dx, dy, dw, dh } = fitPlan(width, height, { fit, warp });
  const { data } = await sharp(input)
    .modulate({ saturation, brightness })
    .extract({ left: sx, top: sy, width: sw, height: sh })
    .resize(dw, dh, { fit: 'fill', kernel })
    .extend({ left: dx, right: SCREEN_W - dw - dx, top: dy, bottom: SCREEN_H - dh - dy, background: fill })
    .flatten({ background: fill })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

/**
 * Write the preview PNG (see renderPreview). Only `scale` 1 with square aspect and no
 * scanlines is a pixel-exact NES screen. A `layout` is embedded as a tEXt chunk for
 * `nesifier check`.
 */
export async function savePng(rgb, path, { scale = 1, aspect = 'square', scanlines = 0, layout = null } = {}) {
  const { data, width, height } = renderPreview(rgb, { scale, aspect, scanlines });
  let png = await sharp(data, { raw: { width, height, channels: 3 } }).png({ palette: false }).toBuffer();
  if (layout) png = embedText(png, LAYOUT_KEY, JSON.stringify(layout));
  await writeFile(path, png);
  return { width, height };
}

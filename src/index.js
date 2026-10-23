// Node entry point: the browser-safe core plus file and image I/O through sharp.
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { SCREEN_W, SCREEN_H } from './nes.js';
import { fitPlan, cropboxPixels, renderPreview, embedText, LAYOUT_KEY } from './core.js';

export * from './core.js';

/**
 * Load and fit an image to 256x240 (see fitPlan). `kernel` is a sharp resize kernel;
 * `fill` pads `contain` fits and replaces transparency. With a `cropbox` (tiles) the
 * image is fitted to that area and the rest of the screen is `letterbox`.
 */
export async function loadImage(input, { fit = 'cover', kernel = 'lanczos3', fill = '#000000', saturation = 1, brightness = 1, warp = 'square', cropbox = null, letterbox = '#000000' } = {}) {
  const { width, height } = await sharp(input).metadata();
  const { sx, sy, sw, sh, dx, dy, dw, dh } = fitPlan(width, height, { fit, warp, cropbox });
  const box = cropboxPixels(cropbox);
  // Flatten inside the box first so transparency and padding there use `fill`.
  const boxed = await sharp(input)
    .modulate({ saturation, brightness })
    .extract({ left: sx, top: sy, width: sw, height: sh })
    .resize(dw, dh, { fit: 'fill', kernel })
    .extend({ left: dx - box.x, right: box.x + box.w - dw - dx, top: dy - box.y, bottom: box.y + box.h - dh - dy, background: fill })
    .flatten({ background: fill })
    .removeAlpha()
    .toBuffer();
  const { data } = await sharp(boxed)
    .extend({ left: box.x, right: SCREEN_W - box.w - box.x, top: box.y, bottom: SCREEN_H - box.h - box.y, background: letterbox })
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

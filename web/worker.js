// Runs conversions off the main thread so the controls stay responsive.
import {
  fitPlan, modulate, nesify, verify, toChr, toNametable, toPal, toOam, toJson, toRom, SCREEN_W, SCREEN_H,
} from './src/core.js';

let bitmap = null;

// Resample RGBA by area averaging: each output pixel is the exact average of the source
// area it covers (weighted by alpha), which keeps thin lines from surviving as streaks
// the way plain canvas scaling does. Separable: rows first, then columns.
function areaResize(src, sw, sh, dw, dh) {
  const pass = (data, w, h, outW, horizontal) => {
    const n = horizontal ? w : h, m = outW, lines = horizontal ? h : w;
    const out = new Float32Array((horizontal ? outW * h : w * outW) * 4);
    const scale = n / m;
    for (let j = 0; j < m; j++) {
      const a = j * scale, b = a + scale;
      for (let i = Math.floor(a); i < Math.min(n, Math.ceil(b)); i++) {
        const wgt = Math.min(b, i + 1) - Math.max(a, i);
        for (let l = 0; l < lines; l++) {
          const s = (horizontal ? l * w + i : i * w + l) * 4;
          const o = (horizontal ? l * outW + j : j * w + l) * 4;
          const alpha = data[s + 3] * wgt;
          out[o] += data[s] * alpha; out[o + 1] += data[s + 1] * alpha; out[o + 2] += data[s + 2] * alpha;
          out[o + 3] += alpha;
        }
      }
    }
    // Back from alpha-weighted sums to colors plus average alpha.
    for (let o = 0; o < out.length; o += 4) {
      const a = out[o + 3];
      if (a > 0) { out[o] /= a; out[o + 1] /= a; out[o + 2] /= a; }
      out[o + 3] = a / scale;
    }
    return out;
  };
  const rows = pass(src, sw, sh, dw, true);
  return pass(rows, dw, sh, dh, false);
}

// Draw the image onto the 256x240 screen as planned by fitPlan, over the fill color.
function fitToScreen(img, { fit, fill, pixelArt, warp }) {
  let { sx, sy, sw, sh, dx, dy, dw, dh } = fitPlan(img.width, img.height, { fit, warp });
  const canvas = new OffscreenCanvas(SCREEN_W, SCREEN_H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  if (pixelArt) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  } else {
    // Halve very large crops on the canvas first to bound memory, then area-average.
    let src = img;
    while (sw > dw * 4 || sh > dh * 4) {
      const nw = Math.ceil(sw / 2), nh = Math.ceil(sh / 2);
      const step = new OffscreenCanvas(nw, nh);
      const sctx = step.getContext('2d');
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(src, sx, sy, sw, sh, 0, 0, nw, nh);
      src = step;
      sx = 0; sy = 0; sw = nw; sh = nh;
    }
    const crop = new OffscreenCanvas(sw, sh);
    const cctx = crop.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    const small = areaResize(cctx.getImageData(0, 0, sw, sh).data, sw, sh, dw, dh);

    // Composite over the fill color (transparent areas become the fill).
    const screen = ctx.getImageData(dx, dy, dw, dh);
    const px = screen.data;
    for (let p = 0; p < px.length; p += 4) {
      const a = Math.min(255, small[p + 3]) / 255;
      for (let c = 0; c < 3; c++) px[p + c] = Math.round(small[p + c] * a + px[p + c] * (1 - a));
    }
    ctx.putImageData(screen, dx, dy);
  }

  const rgba = ctx.getImageData(0, 0, SCREEN_W, SCREEN_H).data;
  const rgb = new Uint8Array(SCREEN_W * SCREEN_H * 3);
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    rgb[q] = rgba[p]; rgb[q + 1] = rgba[p + 1]; rgb[q + 2] = rgba[p + 2];
  }
  return rgb;
}

self.onmessage = ({ data: msg }) => {
  if (msg.type === 'image') {
    bitmap?.close();
    bitmap = msg.bitmap;
    return;
  }
  if (msg.type !== 'convert') return;
  const { id, opts } = msg;
  if (!bitmap) { self.postMessage({ id, skipped: true }); return; }

  try {
    const t0 = performance.now();
    const source = modulate(fitToScreen(bitmap, opts), opts);
    const r = nesify(source, {
      dither: opts.dither, strength: opts.strength, sprites: opts.sprites, maxTiles: opts.maxTiles,
    });
    const chr = toChr(r.tiles, r.spriteTiles);
    const nam = toNametable(r.nametable, r.assign);
    const pal = toPal(r.palettes, r.spritePalettes);
    const oam = r.sprites.length ? toOam(r.sprites) : null;
    const rom = toRom(chr, nam, pal, oam);
    const check = verify(r.rgb, SCREEN_W, SCREEN_H, r.layout);
    self.postMessage({
      id,
      ms: performance.now() - t0,
      rgb: r.rgb,
      source,
      layout: r.layout,
      json: toJson(r.palettes, r.tiles.length, r.spritePalettes, r.sprites.length),
      tiles: r.tiles.length,
      uniqueBefore: r.uniqueBefore,
      sprites: r.sprites.map(({ x, y }) => ({ x, y })),
      check: { ok: check.ok, errors: check.errors, colors: check.stats?.colors ?? null },
      files: { chr, nam, pal, oam, rom },
    });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { loadImage, nesify } from '../src/index.js';
import { verify } from '../src/verify.js';
import { toChr, toNametable, toPal } from '../src/export.js';
import { NES_COLORS, SCREEN_W, SCREEN_H } from '../src/nes.js';

// A busy synthetic image: color noise over gradients forces palette and tile reduction.
async function noisyImage() {
  const w = 300, h = 200;
  const buf = Buffer.alloc(w * h * 3);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = (x * 255) / w * 0.7 + rnd() * 70;
      buf[i + 1] = (y * 255) / h * 0.7 + rnd() * 70;
      buf[i + 2] = ((x + y) % 64) * 3 + rnd() * 50;
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// Decode exported binaries the way the PPU would and return RGB.
function decode(chr, nam, pal) {
  const out = new Uint8Array(SCREEN_W * SCREEN_H * 3);
  const byNes = new Map(NES_COLORS.map((c) => [c.nes, c.rgb]));
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const tile = nam[(y >> 3) * 32 + (x >> 3)];
      const lo = chr[tile * 16 + (y & 7)], hi = chr[tile * 16 + 8 + (y & 7)];
      const bit = 7 - (x & 7);
      const v = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
      const attr = nam[960 + (y >> 5) * 8 + (x >> 5)];
      const shift = (((y >> 4) & 1) << 2) | (((x >> 4) & 1) << 1);
      const p = (attr >> shift) & 3;
      out.set(byNes.get(pal[v === 0 ? 0 : p * 4 + v]), (y * SCREEN_W + x) * 3);
    }
  }
  return out;
}

for (const dither of ['none', 'ordered', 'fs']) {
  test(`output obeys NES rules and exports round-trip (dither=${dither})`, async () => {
    const rgb = await loadImage(await noisyImage(), { fit: 'contain' });
    const r = nesify(rgb, { dither });

    assert.ok(r.tiles.length <= 256);
    assert.equal(r.palettes.length, 4);
    assert.ok(r.palettes.every((p) => p.length === 4 && p[0] === r.palettes[0][0]));
    assert.ok(r.reduced, 'noisy input should need tile reduction');

    const v = verify(r.rgb, SCREEN_W, SCREEN_H);
    assert.deepEqual(v.errors, []);
    assert.ok(v.stats.colors <= 13);

    const chr = toChr(r.tiles), nam = toNametable(r.nametable, r.assign), pal = toPal(r.palettes);
    assert.equal(chr.length, 4096);
    assert.equal(nam.length, 1024);
    assert.equal(pal.length, 16);
    assert.deepEqual(decode(chr, nam, pal), r.rgb);
  });
}

test('forced background color is used as the universal color', async () => {
  const rgb = await loadImage(await noisyImage());
  const r = nesify(rgb, { bg: '#000000' });
  assert.equal(NES_COLORS[r.palettes[0][0]].nes, 0x0f);
});

test('verify rejects a raw photo-like image', async () => {
  const rgb = await loadImage(await noisyImage());
  const v = verify(rgb, SCREEN_W, SCREEN_H);
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /not in the NES palette/);
  assert.equal(verify(rgb, 320, 200).ok, false);
});

test('CRT preview options change only the preview PNG', async () => {
  const { savePng } = await import('../src/index.js');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const rgb = new Uint8Array(SCREEN_W * SCREEN_H * 3).fill(200);
  const file = join(tmpdir(), `nesifier-test-${process.pid}.png`);

  const size = await savePng(rgb, file, { scale: 3, aspect: '4:3', scanlines: 0.5 });
  assert.deepEqual(size, { width: 960, height: 720 });
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 960);
  const row = (y) => data[(y * info.width + 100) * info.channels];
  assert.equal(row(0), 200);
  assert.equal(row(2), 100); // last line of each NES scanline is darkened

  assert.deepEqual(await savePng(rgb, file, { aspect: 'ntsc' }), { width: 293, height: 240 });
});

test('embedded layout survives a PNG round trip', async () => {
  const { embedText, readText } = await import('../src/pngtext.js');
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toBuffer();
  const tagged = embedText(png, 'nesifier-layout', '{"a":1}');
  assert.equal(readText(tagged, 'nesifier-layout'), '{"a":1}');
  assert.equal(readText(png, 'nesifier-layout'), null);
  await sharp(tagged).raw().toBuffer(); // still a valid PNG
});

test('--warp pre-squeezes so the stretched display is undistorted', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
    '<rect width="800" height="600" fill="#000"/><circle cx="400" cy="300" r="250" fill="#fff"/></svg>');
  const ratio = (rgb, k) => {
    let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) {
      if (rgb[(y * SCREEN_W + x) * 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return ((x1 - x0 + 1) * k) / (y1 - y0 + 1); // width as the TV shows it
  };
  const { ASPECTS } = await import('../src/index.js');
  for (const fit of ['contain', 'cover']) {
    for (const warp of ['ntsc', '4:3']) {
      const rgb = await loadImage(svg, { fit, warp });
      assert.ok(Math.abs(ratio(rgb, ASPECTS[warp]) - 1) < 0.02, `${fit}/${warp} circle should stay round`);
    }
    assert.ok(ratio(await loadImage(svg, { fit }), ASPECTS['4:3']) > 1.2, 'unwarped circle widens on a 4:3 TV');
  }
});

test('library output with result.layout passes check exactly', async () => {
  const { savePng, LAYOUT_KEY } = await import('../src/index.js');
  const { readText } = await import('../src/pngtext.js');
  const { readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const r = nesify(await loadImage(await noisyImage()));
  const file = join(tmpdir(), `nesifier-layout-${process.pid}.png`);
  await savePng(r.rgb, file, { layout: r.layout });
  const layout = JSON.parse(readText(await readFile(file), LAYOUT_KEY));
  assert.deepEqual(layout, r.layout);
  assert.deepEqual(verify(r.rgb, SCREEN_W, SCREEN_H, layout).errors, []);
});

test('a crop box fits the image inside it and keeps the letterbox flat', async () => {
  const cropbox = { x: 3, y: 5, w: 20, h: 13 }; // odd edges cut through palette areas
  const rgb = await loadImage(await noisyImage(), { cropbox, letterbox: '#203040' });
  const inBox = (x, y) => x >= 24 && x < 184 && y >= 40 && y < 144;
  const r = nesify(rgb, { cropbox, bg: '#203040', dither: 'ordered', sprites: 64 });
  assert.ok(verify(r.rgb, SCREEN_W, SCREEN_H, r.layout).ok);
  const letterbox = NES_COLORS.find((c) => c.hex === '#00323C').rgb; // nearest to #203040
  let inside = 0;
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const px = [...r.rgb.subarray((y * SCREEN_W + x) * 3, (y * SCREEN_W + x) * 3 + 3)];
      if (inBox(x, y)) inside += px.join() !== letterbox.join();
      else assert.deepEqual(px, letterbox, `letterbox pixel ${x},${y}`);
    }
  }
  assert.ok(inside > 160 * 104 * 0.9, 'the image fills the box');
  assert.ok(r.sprites.length > 0);
  for (const s of r.sprites) assert.ok(s.x + 8 > 24 && s.x < 184 && s.y + 8 > 40 && s.y < 144, 'sprites stay on the image');
});

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

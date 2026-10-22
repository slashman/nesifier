import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { NES } from 'jsnes';
import { loadImage, nesify, verify, toChr, toNametable, toPal, toOam, toRom, NES_COLORS } from '../src/index.js';
import { SCREEN_W, SCREEN_H } from '../src/nes.js';

// Small bright details on a calm background: the case sprites are for.
async function detailedImage() {
  let dots = '';
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const colors = ['#ff2020', '#20e040', '#ffe000', '#ff60ff', '#40c0ff'];
  for (let i = 0; i < 120; i++) {
    dots += `<circle cx="${(rnd() * 380 + 10) | 0}" cy="${(rnd() * 280 + 10) | 0}" r="${(rnd() * 5 + 3) | 0}" fill="${colors[i % colors.length]}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
    <rect width="400" height="300" fill="#202848"/><rect y="200" width="400" height="100" fill="#5a3a1a"/>${dots}</svg>`;
  return loadImage(await sharp(Buffer.from(svg)).png().toBuffer());
}

const rmsUnder = (sprites, a, b, src) => {
  let ea = 0, eb = 0, n = 0;
  for (const s of sprites) {
    for (let i = 0; i < 64; i++) {
      const p = ((s.y + (i >> 3)) * SCREEN_W + s.x + (i & 7)) * 3;
      for (let c = 0; c < 3; c++) { ea += (a[p + c] - src[p + c]) ** 2; eb += (b[p + c] - src[p + c]) ** 2; n++; }
    }
  }
  return [Math.sqrt(ea / n), Math.sqrt(eb / n)];
};

test('sprites obey hardware limits and improve the image where placed', async () => {
  const src = await detailedImage();
  const plain = nesify(src);
  const r = nesify(src, { sprites: 64 });

  assert.ok(r.sprites.length > 0 && r.sprites.length <= 64);
  assert.ok(r.spritePalettes.length <= 4 && r.spritePalettes.every((p) => p.length === 3));
  const perLine = new Uint8Array(SCREEN_H);
  const covered = new Uint8Array(SCREEN_W * SCREEN_H);
  for (const s of r.sprites) {
    assert.ok(s.y >= 1 && s.y <= SCREEN_H - 8 && s.x >= 0 && s.x <= SCREEN_W - 8);
    for (let i = 0; i < 64; i++) {
      const p = (s.y + (i >> 3)) * SCREEN_W + s.x + (i & 7);
      assert.equal(covered[p], 0, 'sprites do not overlap');
      covered[p] = 1;
    }
    for (let dy = 0; dy < 8; dy++) perLine[s.y + dy]++;
  }
  assert.ok(Math.max(...perLine) <= 8, 'at most 8 sprites per scanline');

  // The background layer is identical; sprites only change what they cover.
  assert.deepEqual(r.palettes, plain.palettes);
  const [before, after] = rmsUnder(r.sprites, plain.rgb, r.rgb, src);
  assert.ok(after < before * 0.9, `error under sprites should drop (was ${before.toFixed(1)}, now ${after.toFixed(1)})`);

  assert.deepEqual(verify(r.rgb, SCREEN_W, SCREEN_H, r.layout).errors, []);
});

test('check catches broken sprite layouts', async () => {
  const r = nesify(await detailedImage(), { sprites: 64 });
  const s = r.sprites[0];
  const i = s.pattern.findIndex((v) => v);

  // A sprite pixel that doesn't match the sprite's color.
  const tampered = Uint8Array.from(r.rgb);
  const p = ((s.y + (i >> 3)) * SCREEN_W + s.x + (i & 7)) * 3;
  const other = NES_COLORS.find((c) => c.hex !== r.layout.sprites.palettes[s.palette][s.pattern[i] - 1]);
  tampered.set(other.rgb, p);
  assert.match(verify(tampered, SCREEN_W, SCREEN_H, r.layout).errors.join(), /don't match the sprite/);

  // Nine sprites on one scanline.
  const crowded = structuredClone(r.layout);
  const blank = '0'.repeat(64);
  crowded.sprites.list = Array.from({ length: 9 }, (_, k) => ({ x: k * 8, y: 100, palette: 0, pattern: blank }));
  assert.match(verify(r.rgb, SCREEN_W, SCREEN_H, crowded).errors.join(), /more than 8 sprites/);

  // A sprite on line 0, which the hardware can't show.
  const top = structuredClone(r.layout);
  top.sprites.list = [{ x: 0, y: 0, palette: 0, pattern: blank }];
  assert.match(verify(r.rgb, SCREEN_W, SCREEN_H, top).errors.join(), /Malformed sprite/);
});

test('sprite exports have the NES layouts', async () => {
  const r = nesify(await detailedImage(), { sprites: 64 });
  const chr = toChr(r.tiles, r.spriteTiles);
  const pal = toPal(r.palettes, r.spritePalettes);
  const oam = toOam(r.sprites);
  assert.equal(chr.length, 8192);
  assert.equal(pal.length, 32);
  assert.equal(pal[16], pal[0], '$3F10 mirrors $3F00, so it repeats the universal color');
  assert.equal(oam.length, 256);
  const s = r.sprites[0];
  assert.deepEqual([...oam.subarray(0, 4)], [s.y - 1, s.tile, s.palette, s.x]);
  if (r.sprites.length < 64) assert.equal(oam[r.sprites.length * 4], 0xff, 'unused sprites are off screen');

  // Without sprites the files are the background-only sizes.
  const plain = nesify(await detailedImage());
  assert.equal(toChr(plain.tiles, plain.spriteTiles).length, 4096);
  assert.equal(toPal(plain.palettes, plain.spritePalettes).length, 16);
});

test('ROM with sprites draws the same screen as the preview in an emulator', async () => {
  const r = nesify(await detailedImage(), { sprites: 64, dither: 'fs' });
  const rom = toRom(toChr(r.tiles, r.spriteTiles), toNametable(r.nametable, r.assign),
    toPal(r.palettes, r.spritePalettes), toOam(r.sprites));

  let frame;
  const nes = new NES({ onFrame: (b) => { frame = Uint32Array.from(b); } });
  nes.loadROM(rom);
  nes.ppu.clipToTvSize = false;
  for (let i = 0; i < 30; i++) nes.frame(); // several frames: sprites are refreshed every vblank
  assert.ok(!nes.crashed);

  const code = new Map(NES_COLORS.map((c) => [c.hex, c.nes]));
  const table = nes.ppu.palTable.curTable;
  let bad = 0;
  for (let p = SCREEN_W; p < SCREEN_W * SCREEN_H; p++) { // jsnes never draws line 0
    const hex = '#' + [0, 1, 2].map((c) => r.rgb[p * 3 + c].toString(16).padStart(2, '0')).join('').toUpperCase();
    if ((frame[p] & 0xffffff) !== (table[code.get(hex)] & 0xffffff)) bad++;
  }
  assert.equal(bad, 0, `${bad} pixels differ from the preview`);
});

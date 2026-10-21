import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { NES } from 'jsnes';
import { loadImage, nesify } from '../src/index.js';
import { toChr, toNametable, toPal } from '../src/export.js';
import { toRom } from '../src/rom.js';
import { NES_COLORS, SCREEN_W, SCREEN_H } from '../src/nes.js';

// Boot the ROM in an emulator and compare what the PPU draws with the converter's preview.
async function bootAndCompare(dither) {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#1a4f9c"/><stop offset="1" stop-color="#e8c070"/></linearGradient></defs>' +
    '<rect width="400" height="300" fill="url(#g)"/><circle cx="130" cy="150" r="90" fill="#b02818"/>' +
    '<rect x="230" y="40" width="120" height="220" fill="#2c8a3c"/><text x="20" y="290" font-size="40" fill="#fff">NES</text></svg>');
  const r = nesify(await loadImage(await sharp(svg).png().toBuffer()), { dither });
  const chr = toChr(r.tiles), nam = toNametable(r.nametable, r.assign), pal = toPal(r.palettes);
  const rom = toRom(chr, nam, pal);

  let frame;
  const nes = new NES({ onFrame: (b) => { frame = Uint32Array.from(b); } });
  nes.loadROM(rom);
  nes.ppu.clipToTvSize = false; // jsnes otherwise blanks an 8-pixel TV border
  for (let i = 0; i < 10; i++) nes.frame();
  return { r, rom, chr, nam, pal, nes, frame };
}

test('ROM has a valid NROM layout', async () => {
  const { rom, pal } = await bootAndCompare('none');
  assert.equal(rom.length, 16 + 0x4000 + 0x2000);
  assert.deepEqual([...rom.subarray(0, 6)], [0x4e, 0x45, 0x53, 0x1a, 1, 1]); // "NES\x1a", 1x16K PRG, 1x8K CHR
  const vec = (off) => rom[16 + off] | (rom[16 + off + 1] << 8);
  assert.equal(vec(0x3ffc), 0xc000, 'reset vector');
  assert.equal(rom[16 + vec(0x3ffe) - 0xc000], 0x40, 'IRQ/NMI handler is RTI');
  assert.deepEqual([...rom.subarray(16 + 0x100, 16 + 0x110)], [...pal]);
});

for (const dither of ['none', 'fs']) {
  test(`ROM draws the same screen as the preview in an emulator (dither=${dither})`, async () => {
    const { r, nes, frame, chr, nam, pal } = await bootAndCompare(dither);
    assert.ok(!nes.crashed, 'emulator did not crash');

    // Video memory holds exactly the exported data.
    const vram = nes.ppu.vramMem;
    assert.deepEqual([...vram.subarray(0x2000, 0x2400)], [...nam], 'nametable + attributes');
    for (let i = 0; i < 16; i++) assert.equal(vram[0x3f00 + i] & 0x3f, i % 4 ? pal[i] : pal[0], `palette entry ${i}`);
    for (const t of [0, r.tiles.length - 1]) {
      const pix = nes.ppu.ptTile[t].pix;
      for (let i = 0; i < 64; i++) assert.equal(pix[i], r.tiles[t][i], `tile ${t} pixel ${i}`);
    }
    assert.equal(chr.length, 4096);

    // Every drawn pixel matches, using the emulator's own RGB table for each NES color.
    // jsnes never draws screen line 0 (its buffer row 0 is the pre-render line), so
    // start at line 1; line 0's data is covered by the video memory checks above.
    const code = new Map(NES_COLORS.map((c) => [c.hex, c.nes]));
    const table = nes.ppu.palTable.curTable;
    let bad = 0;
    for (let p = SCREEN_W; p < SCREEN_W * SCREEN_H; p++) {
      const hex = '#' + [0, 1, 2].map((c) => r.rgb[p * 3 + c].toString(16).padStart(2, '0')).join('').toUpperCase();
      if ((frame[p] & 0xffffff) !== (table[code.get(hex)] & 0xffffff)) bad++;
    }
    assert.equal(bad, 0, `${bad} pixels differ from the preview`);
  });
}

import { NES_COLORS, MAP_W, MAP_H, BLOCKS_W, BLOCKS_H, MAX_TILES } from './nes.js';

/** Pattern table: 256 tiles x 16 bytes, low bitplane then high bitplane per tile. */
export function toChr(tiles) {
  const out = new Uint8Array(MAX_TILES * 16);
  tiles.forEach((pat, t) => {
    for (let y = 0; y < 8; y++) {
      let lo = 0, hi = 0;
      for (let x = 0; x < 8; x++) {
        const v = pat[y * 8 + x];
        lo |= (v & 1) << (7 - x);
        hi |= ((v >> 1) & 1) << (7 - x);
      }
      out[t * 16 + y] = lo;
      out[t * 16 + 8 + y] = hi;
    }
  });
  return out;
}

/** Nametable (960 tile indices) followed by its 64-byte attribute table. */
export function toNametable(nametable, assign) {
  const out = new Uint8Array(1024);
  out.set(nametable.subarray(0, MAP_W * MAP_H));
  const pal = (bx, by) => (bx < BLOCKS_W && by < BLOCKS_H ? assign[by * BLOCKS_W + bx] : 0);
  for (let ay = 0; ay < 8; ay++) {
    for (let ax = 0; ax < 8; ax++) {
      const bx = ax * 2, by = ay * 2;
      out[960 + ay * 8 + ax] =
        pal(bx, by) | (pal(bx + 1, by) << 2) | (pal(bx, by + 1) << 4) | (pal(bx + 1, by + 1) << 6);
    }
  }
  return out;
}

/** 16 bytes for PPU $3F00-$3F0F (each palette's entry 0 repeats the universal color). */
export function toPal(palettes) {
  return Uint8Array.from(palettes.flat().map((c) => NES_COLORS[c].nes));
}

export function toJson(palettes, tileCount) {
  const hexNes = (n) => '$' + n.toString(16).padStart(2, '0').toUpperCase();
  return {
    universalBackground: { hex: NES_COLORS[palettes[0][0]].hex, nes: hexNes(NES_COLORS[palettes[0][0]].nes) },
    palettes: palettes.map((p) => p.map((c) => ({ hex: NES_COLORS[c].hex, nes: hexNes(NES_COLORS[c].nes) }))),
    tiles: tileCount,
  };
}

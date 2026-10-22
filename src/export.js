import { NES_COLORS, MAP_W, MAP_H, BLOCKS_W, BLOCKS_H, MAX_TILES } from './nes.js';

/**
 * Pattern tables: 256 tiles x 16 bytes, low bitplane then high bitplane per tile. With
 * sprite tiles, a second 4 KB table follows (PPU $1000) and the result is 8 KB.
 */
export function toChr(tiles, spriteTiles = []) {
  const out = new Uint8Array(MAX_TILES * 16 * (spriteTiles.length ? 2 : 1));
  const all = spriteTiles.length ? [...tiles, ...Array(MAX_TILES - tiles.length).fill(null), ...spriteTiles] : tiles;
  all.forEach((pat, t) => {
    if (!pat) return;
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

/**
 * 16 bytes for PPU $3F00-$3F0F (each palette's entry 0 repeats the universal color), or
 * 32 bytes through $3F1F when there are sprite palettes. Sprite entry 0 is transparent,
 * but $3F10 mirrors $3F00, so it repeats the universal color too.
 */
export function toPal(palettes, spritePalettes = []) {
  const bg = palettes[0][0];
  const sprites = spritePalettes.length
    ? Array.from({ length: 4 }, (_, i) => [bg, ...(spritePalettes[i] ?? spritePalettes[0])])
    : [];
  return Uint8Array.from([...palettes, ...sprites].flat().map((c) => NES_COLORS[c].nes));
}

/**
 * OAM: 64 sprites x 4 bytes (Y - 1, tile, attributes, X). Unused entries get Y = $FF,
 * which keeps them off screen.
 */
export function toOam(sprites) {
  const out = new Uint8Array(256).fill(0xff);
  sprites.forEach((s, i) => {
    out[i * 4] = s.y - 1;
    out[i * 4 + 1] = s.tile;
    out[i * 4 + 2] = s.palette; // in front of the background, not flipped
    out[i * 4 + 3] = s.x;
  });
  return out;
}

export function toJson(palettes, tileCount, spritePalettes = [], spriteCount = 0) {
  const hexNes = (n) => '$' + n.toString(16).padStart(2, '0').toUpperCase();
  const color = (c) => ({ hex: NES_COLORS[c].hex, nes: hexNes(NES_COLORS[c].nes) });
  const json = {
    universalBackground: color(palettes[0][0]),
    palettes: palettes.map((p) => p.map(color)),
    tiles: tileCount,
  };
  if (spriteCount) {
    json.spritePalettes = spritePalettes.map((p) => p.map(color)); // entry 0 is transparent
    json.sprites = spriteCount;
  }
  return json;
}

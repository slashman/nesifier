// Hardware constants for a strict NES background (single nametable, no mid-frame tricks).
export const SCREEN_W = 256;
export const SCREEN_H = 240;
export const TILE = 8;
export const MAP_W = SCREEN_W / TILE; // 32
export const MAP_H = SCREEN_H / TILE; // 30
export const ATTR = 16; // one palette per 16x16 area (2x2 tiles)
export const BLOCKS_W = SCREEN_W / ATTR; // 16
export const BLOCKS_H = SCREEN_H / ATTR; // 15
export const NUM_PALETTES = 4;
export const COLORS_PER_PALETTE = 4; // entry 0 is the shared universal background color
export const MAX_TILES = 256;

// Usable background colors (common NTSC approximation), paired with the PPU palette
// index each one approximates. Duplicates and special-purpose entries ($0D, $0E, $1D-$1F,
// $2E-$30, $3D-$3F) are omitted; black is emitted as the safe $0F.
export const NES_COLORS = [
  [0x00, '#545454'], [0x01, '#001E74'], [0x02, '#081090'], [0x03, '#300088'],
  [0x04, '#440064'], [0x05, '#5C0030'], [0x06, '#540400'], [0x07, '#3C1800'],
  [0x08, '#202A00'], [0x09, '#083A00'], [0x0A, '#004000'], [0x0B, '#003C00'],
  [0x0C, '#00323C'], [0x0F, '#000000'],
  [0x10, '#989698'], [0x11, '#084CC4'], [0x12, '#3032EC'], [0x13, '#5C1EE4'],
  [0x14, '#8814B0'], [0x15, '#A01464'], [0x16, '#982220'], [0x17, '#783C00'],
  [0x18, '#545A00'], [0x19, '#287200'], [0x1A, '#087C00'], [0x1B, '#007628'],
  [0x1C, '#006678'],
  [0x20, '#ECEEEC'], [0x21, '#4C9AEC'], [0x22, '#787CEC'], [0x23, '#B062EC'],
  [0x24, '#E454EC'], [0x25, '#EC58B4'], [0x26, '#EC6A64'], [0x27, '#D48820'],
  [0x28, '#A0AA00'], [0x29, '#74C400'], [0x2A, '#4CD020'], [0x2B, '#38CC6C'],
  [0x2C, '#38B4CC'], [0x2D, '#3C3C3C'],
  [0x31, '#A8CCEC'], [0x32, '#BCBCEC'], [0x33, '#D4B2EC'], [0x34, '#ECAEDC'],
  [0x36, '#ECB4B0'], [0x37, '#E4C490'], [0x38, '#CCD278'], [0x39, '#B4DE78'],
  [0x3A, '#A8E290'], [0x3B, '#98E2B4'], [0x3C, '#A0D6E4'],
].map(([nes, hex]) => ({ nes, hex, rgb: hexToRgb(hex) }));

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

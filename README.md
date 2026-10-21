# nesifier

Convert any image into a **strict NES background**: something the PPU can actually
display from a single nametable with no mid-frame palette changes.

```sh
npm install
node bin/nesifier.js photo.jpg -s 3              # -> photo.nes.png (768x720 preview)
node bin/nesifier.js photo.jpg -d fs -e out/pic  # + out/pic.chr .nam .pal .json
node bin/nesifier.js check some-image.png        # verify an existing image
npm link                                         # optional: install the `nesifier` command
```

## Constraints enforced

| Rule | Value |
|---|---|
| Resolution | 256 × 240 |
| Tiles / map | 8 × 8 tiles, 32 × 30 nametable |
| Tile patterns | ≤ 256 unique, no flipping (only exact repeats are free) |
| Palettes | 4 background palettes × 4 entries |
| Universal background | entry 0 of every palette is the same color (no transparency) |
| Total colors | ≤ 13 (1 shared + 3 per palette) |
| Attribute granularity | one palette per 16 × 16 area (2 × 2 tiles) |
| Colors | only the 52 usable NES colors (NTSC approximation, see `src/nes.js`) |

Every conversion ends by running the independent verifier (`src/verify.js`) on the
rendered result, and the CLI exits non-zero if any rule is broken.

## How it works

1. **Fit**: resize to 256×240 with sharp (`--fit cover|contain|fill`).
2. **Palettes**: each 16×16 block is summarized as a histogram over NES colors in
   CIELAB. For each candidate universal background color, blocks are clustered into 4
   groups (k-means style), and each group's 3 colors are found by **exhaustive search**
   over all C(51,3) triples. The background with the lowest total error wins.
3. **Pixels**: each pixel picks from its block's 4 colors, optionally with ordered
   (Bayer 4×4) or Floyd–Steinberg dithering that stays within each block's palette.
4. **Tiles**: if there are more than 256 unique 8×8 patterns, cells are clustered into
   ≤ 256 patterns. Error is measured *through each cell's own palette*, so one pattern
   can serve cells that use different palettes.
5. **Render**: the preview is rebuilt from nametable → pattern → palette, exactly as
   the hardware would draw it.

## Options

```
-o, --output <file>       preview PNG (default: <input>.nes.png)
-s, --scale <n>           nearest-neighbor upscale for the preview
-e, --export <base>       write <base>.chr .nam .pal .json
    --fit <mode>          cover | contain | fill (default cover)
    --resample <kernel>   lanczos3 | nearest | cubic | mitchell (nearest for pixel art)
    --fill <#hex>         padding color for --fit contain
    --saturation <n>      pre-boost saturation (photos often look better at 1.3–1.6)
    --brightness <n>      brightness multiplier
-d, --dither <mode>       none | ordered | fs
    --strength <0..1>     dither strength (default 0.75)
    --bg <#hex>           force the universal background color
    --bg-candidates <n>   background colors to try (default 6)
    --max-tiles <n>       tile budget ≤ 256 (lower it to leave room for text/fonts)
-q, --quiet
```

## Export formats

- `.chr`: 4096 bytes, 256 tiles × 16 bytes (bitplane 0, then bitplane 1). Unused tiles are zero.
- `.nam`: 1024 bytes, 960 tile indices followed by the 64-byte attribute table.
- `.pal`: 16 bytes for `$3F00–$3F0F` (PPU color indices; entry 0 of each palette repeats the universal color).
- `.json`: palettes as hex and `$xx` PPU indices.

These load directly into tools like NEXXT/NES Screen Tool, or `.incbin` into a ROM.

## Notes

- Scrolling is a runtime feature; the output is one full nametable that you can scroll.
- Dithering creates many unique tiles, so tile reduction will smooth some of it out.
- Preview PNGs carry the palette layout in a `nesifier-layout` text chunk. `check`
  verifies the image against it, so it never makes an invalid image pass. Without that chunk
  (other tools, or editors that strip metadata) `check` has to search for an
  arrangement itself, and a tile-count failure then means "none found", not "impossible".
- Hex values follow one common NTSC palette; real hardware and emulators vary.

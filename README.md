# nesifier

Turn any image into a real NES background: a screen the console can actually display,
with the NES's own limits on colors, palettes and tiles. You get a preview PNG, the raw
graphics data for NES development, or a `.nes` ROM that shows the image in any emulator.

Requires Node.js 18.17 or newer.

## Quick start

```sh
npx nesifier photo.jpg
```

This writes `photo.nes.png`, the 256×240 screen exactly as the NES would draw it. Add
`-s 3` for a bigger preview:

```sh
npx nesifier photo.jpg -s 3
```

To use the `nesifier` command without `npx`, install it globally:

```sh
npm install -g nesifier
```

## Recipes

```sh
# Make a ROM you can open in an emulator or put on a flash cart
npx nesifier photo.jpg -r photo.nes

# Preview it the way a CRT TV showed it
npx nesifier photo.jpg -s 3 --aspect 4:3 --scanlines

# Dither for smoother gradients
npx nesifier photo.jpg -d fs

# Punch up a soft photo before converting
npx nesifier photo.jpg --saturation 1.5

# Cinematic band like Ninja Gaiden's cutscenes, leaving the rest of the screen black
npx nesifier photo.jpg --cropbox band

# A custom 20x12-tile window at tile (6, 4), on a dark blue letterbox
npx nesifier photo.jpg --cropbox 6,4,20,12 --letterbox '#001E74'

# Pixel art: keep hard edges and show the whole image
npx nesifier sprite-sheet.png --resample nearest --fit contain

# Export graphics data for your own NES project
npx nesifier photo.jpg -e out/title     # out/title.chr .nam .pal .json

# Leave 32 tiles free for a font or HUD
npx nesifier photo.jpg --max-tiles 224 -e out/title

# Check whether an image already follows the NES rules
npx nesifier check image.png
```

## Options

```
nesifier <input> [options]
nesifier check <image>
```

**Output**

| Option | Description |
|---|---|
| `-o, --output <file>` | Preview PNG path. Default: `<input>.nes.png` |
| `-s, --scale <n>` | Enlarge the preview with sharp pixels (1–16) |
| `--aspect <mode>` | Preview shape: `square` (default), `ntsc` (8:7 pixels) or `4:3` (TV frame). Also sets `--warp` unless you give one |
| `--scanlines` | Darken alternate lines like a CRT. Sets `--scale` to at least 2 |
| `--scanline-strength <0..1>` | How dark the scanlines are. Default 0.5 |
| `-r, --rom <file>` | Write a `.nes` ROM that displays the image |
| `-e, --export <base>` | Write `<base>.chr`, `.nam`, `.pal` and `.json`, plus `.oam` with sprites |

**Fitting the image**

| Option | Description |
|---|---|
| `--fit <mode>` | `cover` crops to fill the screen (default), `contain` shows the whole image with padding, `fill` stretches |
| `--fill <#hex>` | Padding color for `--fit contain`. Default `#000000` |
| `--cropbox <box>` | Fit the image into part of the screen instead of all of it: `band` (full width, 16 tiles tall), `small` (24×16 tiles, centered), `x,y,w,h` in 8×8 tiles, or `full` (default). `--fit` and `--warp` work on the box |
| `--letterbox <#hex>` | Color around the crop box. It also becomes the shared background color unless you give `--bg`. Default `#000000` |
| `--warp <mode>` | `square`, `ntsc` or `4:3`: pre-squeeze the image so it looks undistorted once a TV stretches it. Default: same as `--aspect` |
| `--resample <kernel>` | `lanczos3` (default, photos), `nearest` (pixel art), `cubic`, `mitchell` |
| `--saturation <n>` | Saturation multiplier before converting. Photos often look better at 1.3–1.6 |
| `--brightness <n>` | Brightness multiplier before converting |

**Conversion**

| Option | Description |
|---|---|
| `-d, --dither <mode>` | `none` (default), `ordered` (pattern) or `fs` (Floyd–Steinberg) |
| `--strength <0..1>` | Dither strength. Default 0.75 |
| `--bg <#hex>` | Force the shared background color |
| `--bg-candidates <n>` | How many background colors to try. Default 6 |
| `--max-tiles <n>` | Tile budget, up to 256. Lower it to leave room for other graphics |
| `--sprites <n>` | Up to `n` 8×8 sprites (0–64) added where the background is least accurate. Default 64; `0` for background only |
| `-q, --quiet` | Only print errors |

`--scale`, `--aspect` and `--scanlines` only change the preview PNG. The ROM and exported
data are always the plain 256×240 screen.

## What you get

**Preview PNG.** The screen as the NES draws it. Without `--scale`, `--aspect` or
`--scanlines`, it is pixel-exact and passes `nesifier check`.

**ROM (`-r`).** A 24 KB `.nes` file (NROM, mapper 0) that shows the image and waits.
With sprites, it refreshes the sprite table every frame, as games do.
It runs in emulators such as Mesen and FCEUX, and on flash carts. Colors vary a little
between emulators, and many emulators and TVs hide the outer 8 pixels (overscan).

**Graphics data (`-e`).** Standard NES formats you can load into tools like NEXXT or
NES Screen Tool, or include in a ROM build with `.incbin`:

| File | Size | Contents |
|---|---|---|
| `.chr` | 4096 bytes | 256 tiles × 16 bytes (bitplane 0, then bitplane 1). Unused tiles are empty. 8192 bytes with sprites: sprite tiles follow at `$1000` |
| `.nam` | 1024 bytes | 960 tile numbers followed by the 64-byte attribute table |
| `.pal` | 16 bytes | Background palettes for PPU `$3F00–$3F0F`, as NES color numbers. 32 bytes with sprites, through `$3F1F` |
| `.oam` | 256 bytes | With sprites only: the sprite table (Y − 1, tile, attributes, X), ready for OAM DMA. Unused sprites are off screen |
| `.json` | | The palettes (and sprite palettes) as hex colors and `$xx` NES color numbers |

## Checking an image

```sh
npx nesifier check image.png
```

`check` reports every rule an image breaks and exits with status 1, or prints the
palettes and exits with 0 if the image is valid. Images made by nesifier store their
palette arrangement in the PNG, so `check` can verify them exactly. For images from other
tools, `check` has to search for an arrangement. If it can't find one within the tile
limit, it says so, but the image may still be valid.

## Using it as a library

```js
import { loadImage, nesify, savePng, toChr, toNametable, toPal, toOam, toRom } from 'nesifier';
import { writeFile } from 'node:fs/promises';

const screen = await loadImage('photo.jpg', { warp: '4:3' });
const result = nesify(screen, { dither: 'fs', sprites: 64 });

await savePng(result.rgb, 'photo.nes.png', { scale: 3, layout: result.layout });

const chr = toChr(result.tiles, result.spriteTiles);
const nam = toNametable(result.nametable, result.assign);
const pal = toPal(result.palettes, result.spritePalettes);
await writeFile('photo.nes', toRom(chr, nam, pal, toOam(result.sprites)));
```

| Function | Description |
|---|---|
| `loadImage(input, options)` | Load a file path or Buffer and fit it to 256×240. Options: `fit`, `kernel`, `fill`, `warp`, `saturation`, `brightness`, `cropbox`, `letterbox`. Returns RGB bytes |
| `nesify(rgb, options)` | Convert 256×240 RGB bytes. Options: `dither`, `strength`, `bg`, `bgCandidates`, `maxTiles`, `sprites` (default 0, unlike the CLI), `cropbox` (no dithering or sprites outside it). Returns `{ rgb, tiles, nametable, palettes, assign, sprites, spriteTiles, spritePalettes, layout }` |
| `savePng(rgb, path, options)` | Write the preview. Options: `scale`, `aspect`, `scanlines`, `layout` |
| `toChr(tiles, spriteTiles?)`, `toNametable(nametable, assign)`, `toPal(palettes, spritePalettes?)`, `toOam(sprites)` | Encode the NES data files |
| `toJson(palettes, tileCount, spritePalettes?, spriteCount?)` | Palettes as hex colors and NES color numbers |
| `toRom(chr, nam, pal, oam?)` | Build a `.nes` ROM, with sprites if `oam` is given |
| `verify(rgb, width, height, layout?)` | Check an image against the rules. Returns `{ ok, errors, stats }` |
| `parseCropbox(text)`, `CROPBOXES` | Crop boxes in tiles, `{ x, y, w, h }`: parse `band`, `small` or `x,y,w,h`, and the presets |
| `NES_COLORS` | The 52 usable colors: `{ nes, hex, rgb }` |

Pass `layout: result.layout` to `savePng` so the PNG records its palette arrangement for
`nesifier check`.

## The NES rules it follows

| Rule | Limit |
|---|---|
| Screen | 256 × 240 pixels |
| Tiles | 8 × 8 pixels, in a 32 × 30 map |
| Unique tiles | At most 256. Tiles can't be flipped, so only exact repeats are free |
| Palettes | 4 background palettes of 4 colors |
| Background color | One color shared by all 4 palettes, with no transparency |
| Colors on screen | At most 13 (1 shared + 3 per palette) |
| Palette areas | Each 16 × 16 area uses one palette |
| Colors | 52 usable NES colors (a common NTSC approximation) |
| Sprites (optional) | Up to 64 sprites of 8 × 8, at most 8 on any scanline, none on line 0 |
| Sprite palettes | 4 palettes of 3 colors each; sprite color 0 is transparent |

Every conversion is checked against these rules before nesifier reports success.

## How it works

1. **Fit** the image to 256×240.
2. **Choose palettes.** For several candidate background colors, group the screen's
   240 palette areas into 4 palettes, and find each palette's best 3 colors by trying
   every combination. Keep the background color that matches the image best.
3. **Map pixels** to their area's 4 colors, with optional dithering that stays inside
   each area's palette.
4. **Reduce tiles.** Photos usually start with 500–700 unique tiles, so similar tiles
   are merged until at most 256 remain, judging each tile by how it looks in its own
   palette.
5. **Rebuild** the screen from the tiles and palettes, exactly as the NES draws it.

## Tips and limits

- **TV proportions.** NES pixels aren't square: TVs stretch the screen horizontally
  (8:7 per pixel on NTSC, about 4:3 overall). Without correction, circles look 14–25%
  too wide on a TV. `--aspect` previews the TV shape and corrects for it; `--warp` alone
  corrects the data but keeps the plain 256×240 PNG, which then looks squeezed. To see
  the uncorrected distortion, use `--aspect 4:3 --warp square`.
- **Photos lose color.** The NES palette is sparse, so soft or muted photos come out
  greyish. Try `--saturation 1.5`.
- **Sprites suit detail.** Sprites are placed where they fix small features, such as
  eyes, highlights or text, rather than broad areas, where a corrected 8×8 square would
  stand out as a box. They help most on illustrations and game art; on soft photos the
  gain is smaller. Sprite tiles live in their own pattern table, so they don't use the
  background's 256-tile budget. `check` needs the sprite layout stored in nesifier's
  PNGs to verify a sprite image.
- **Crop box edges.** Each 16×16 area has one palette, so a box edge on an odd tile
  splits an area between the image and the letterbox. Because the letterbox color is
  the shared background color (in every palette), that costs nothing. With `--bg` set to
  another color it can, so keep edges on even tiles. The presets already do.
- **Dithering costs tiles.** Dithered areas create many unique tiles, and merging them
  back down to 256 smooths some of the dithering out.
- **Colors vary.** There's no single official NES palette; emulators and TVs differ.
- **Scrolling** is something a game does at runtime. nesifier makes one full screen.

## Development

```sh
git clone https://github.com/slashman/nesifier.git
cd nesifier
npm install
npm test
node bin/nesifier.js photo.jpg -s 3
npm run web          # the web page at http://localhost:8080
```

The tests include booting generated ROMs in an emulator (jsnes) and comparing the frame
with the preview pixel by pixel.

The conversion code in `src/core.js` runs in both Node and browsers; `src/index.js` adds
file and image handling for Node through sharp. The web page (`web/`) loads the core
directly with no build step and converts in a Web Worker. `npm run build:web` assembles a
static copy in `_site/` that can be hosted anywhere.

## License

MIT

The web page's sample image is a crop of
[Girl with a Pearl Earring](https://commons.wikimedia.org/wiki/File:1665_Girl_with_a_Pearl_Earring.jpg)
by Johannes Vermeer (c. 1665), in the public domain.
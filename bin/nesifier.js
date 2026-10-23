#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { loadImage, nesify, savePng, parseCropbox, ASPECTS, LAYOUT_KEY } from '../src/index.js';
import { readText } from '../src/pngtext.js';
import { verify } from '../src/verify.js';
import { toChr, toNametable, toPal, toOam, toJson } from '../src/export.js';
import { toRom } from '../src/rom.js';
import { NES_COLORS } from '../src/nes.js';

const HELP = `nesifier - convert an image to a strict NES background

Usage:
  nesifier <input> [options]        convert an image
  nesifier check <image>            verify an image already obeys NES rules

Output:
  -o, --output <file>       preview PNG (default: <input>.nes.png)
  -s, --scale <n>           upscale the preview with nearest-neighbor (default 1)
      --aspect <mode>       preview shape: square | ntsc (8:7 pixels) | 4:3 (default square)
      --scanlines           darken alternate lines like a CRT (forces --scale >= 2)
      --scanline-strength <0..1>  how dark the scanlines are (default 0.5)
  -e, --export <base>       write <base>.chr, <base>.nam, <base>.pal, <base>.json
                            (and <base>.oam when sprites are used)
  -r, --rom <file>          write a .nes ROM (NROM) that displays the image

Image fitting:
      --fit <mode>          cover | contain | fill (default cover)
      --resample <kernel>   lanczos3 | nearest | cubic | mitchell (default lanczos3)
      --fill <#hex>         padding color for --fit contain (default #000000)
      --cropbox <box>       fit the image to part of the screen: band (32x16 tiles,
                            full width) | small (24x16 tiles, centered) | x,y,w,h in
                            tiles | full (default)
      --letterbox <#hex>    color around the crop box, also the default --bg
                            (default #000000)
      --warp <mode>         pre-squeeze for a stretched display: square | ntsc | 4:3
                            (default: same as --aspect)
      --saturation <n>      saturation multiplier before conversion (default 1)
      --brightness <n>      brightness multiplier before conversion (default 1)

Conversion:
  -d, --dither <mode>       none | ordered | fs (default none)
      --strength <0..1>     dither strength (default 0.75)
      --bg <#hex>           force the universal background color
      --bg-candidates <n>   background colors to try when not forced (default 6)
      --max-tiles <n>       unique tile budget, at most 256 (default 256)
      --sprites <n>         8x8 sprites to add where the background is least accurate,
                            0-64 (default 64; 0 for background only)
  -q, --quiet               only print errors
  -h, --help                show this help

NES rules enforced: 256x240, 8x8 tiles in a 32x30 map, <=256 unique tile patterns
(no flipping), 4 background palettes of 4 colors sharing one universal background
color (<=13 colors total), one palette per 16x16 area, colors from the NES palette.
--scale, --aspect and --scanlines only change the preview PNG; use none of them to get
a pixel-exact 256x240 screen that passes 'nesifier check'.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    scale: { type: 'string', short: 's', default: '1' },
    aspect: { type: 'string', default: 'square' },
    scanlines: { type: 'boolean', default: false },
    'scanline-strength': { type: 'string', default: '0.5' },
    export: { type: 'string', short: 'e' },
    rom: { type: 'string', short: 'r' },
    fit: { type: 'string', default: 'cover' },
    resample: { type: 'string', default: 'lanczos3' },
    fill: { type: 'string', default: '#000000' },
    cropbox: { type: 'string' },
    letterbox: { type: 'string', default: '#000000' },
    warp: { type: 'string' }, // defaults to --aspect
    saturation: { type: 'string', default: '1' },
    brightness: { type: 'string', default: '1' },
    dither: { type: 'string', short: 'd', default: 'none' },
    strength: { type: 'string', default: '0.75' },
    bg: { type: 'string' },
    'bg-candidates': { type: 'string', default: '6' },
    'max-tiles': { type: 'string', default: '256' },
    sprites: { type: 'string', default: '64' },
    quiet: { type: 'boolean', short: 'q', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const log = (...a) => { if (!values.quiet) console.log(...a); };

function num(name, { min = -Infinity, max = Infinity, int = false } = {}) {
  const v = Number(values[name]);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v)))
    fail(`--${name} must be ${int ? 'an integer' : 'a number'} in [${min}, ${max}]`);
  return v;
}

function oneOf(name, choices) {
  if (!choices.includes(values[name])) fail(`--${name} must be one of: ${choices.join(', ')}`);
  return values[name];
}

function fail(msg) {
  console.error(`nesifier: ${msg}`);
  process.exit(2);
}

function report(result) {
  if (result.ok) {
    const { colors, tiles, sprites } = result.stats;
    log(`✓ NES constraints satisfied (${colors} colors, ${tiles} unique tiles${sprites ? `, ${sprites} sprites` : ''})`);
  } else {
    console.error('✗ NES constraint violations:');
    for (const e of result.errors) console.error(`  - ${e}`);
  }
}

function parseLayout(text) {
  try {
    const l = JSON.parse(text);
    const hexOk = (c) => typeof c === 'string' && /^#[0-9A-F]{6}$/.test(c);
    if (l.palettes.length === 4 && l.palettes.every((p) => p.length === 4 && p.every(hexOk)) &&
        l.assign.length === 240 && l.assign.every((a) => Number.isInteger(a) && a >= 0 && a < 4)) return l;
  } catch {}
  return null;
}

async function runCheck(file) {
  const buf = await readFile(file);
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  // Our own PNGs carry their palette layout. It is verified, not trusted, and if it is
  // stale (image edited afterwards) we fall back to deriving one from the pixels.
  const layout = parseLayout(readText(buf, LAYOUT_KEY));
  let result = layout && verify(pixels, info.width, info.height, layout);
  if (!result?.ok) result = verify(pixels, info.width, info.height);
  report(result);
  if (result.ok && result.stats.palettes)
    result.stats.palettes.forEach((p, i) => log(`  palette ${i}: ${p.map((c) => c ?? '(any)').join(' ')}`));
  process.exit(result.ok ? 0 : 1);
}

async function runConvert(input) {
  const output = values.output ?? path.join(path.dirname(input), path.parse(input).name + '.nes.png');
  let scale = num('scale', { min: 1, max: 16, int: true });
  const aspect = oneOf('aspect', Object.keys(ASPECTS));
  // A TV-shaped preview should look right, so correct for the same shape unless told otherwise.
  if (values.warp === undefined) values.warp = aspect;
  const warp = oneOf('warp', Object.keys(ASPECTS));
  if (warp !== 'square' && aspect !== warp)
    log(`Note: --warp ${warp} squeezes the image; preview with --aspect ${warp} to see it undistorted`);
  const scanlines = values.scanlines ? num('scanline-strength', { min: 0, max: 1 }) : 0;
  if (scanlines > 0 && scale < 2) {
    scale = 2;
    log('Scanlines need at least 2 output lines per NES line; using --scale 2');
  }
  let cropbox = null;
  if (values.cropbox !== undefined) {
    try { cropbox = parseCropbox(values.cropbox); } catch (err) { fail(`--cropbox: ${err.message}`); }
  }
  const t0 = performance.now();

  const rgb = await loadImage(input, {
    fit: oneOf('fit', ['cover', 'contain', 'fill']),
    kernel: oneOf('resample', ['lanczos3', 'nearest', 'cubic', 'mitchell']),
    fill: values.fill,
    warp,
    cropbox,
    letterbox: values.letterbox,
    saturation: num('saturation', { min: 0, max: 10 }),
    brightness: num('brightness', { min: 0, max: 10 }),
  });

  const result = nesify(rgb, {
    dither: oneOf('dither', ['none', 'ordered', 'fs']),
    strength: num('strength', { min: 0, max: 1 }),
    // The letterbox as the shared background color is in every palette, so palette
    // areas that the crop box edge cuts through still match both sides.
    bg: values.bg ?? (cropbox ? values.letterbox : undefined),
    bgCandidates: num('bg-candidates', { min: 1, max: NES_COLORS.length, int: true }),
    maxTiles: num('max-tiles', { min: 1, max: 256, int: true }),
    sprites: num('sprites', { min: 0, max: 64, int: true }),
    cropbox,
  });

  const json = toJson(result.palettes, result.tiles.length, result.spritePalettes, result.sprites.length);
  const hasSprites = result.sprites.length > 0;
  const chr = toChr(result.tiles, result.spriteTiles);
  const nam = toNametable(result.nametable, result.assign);
  const pal = toPal(result.palettes, result.spritePalettes);
  const oam = hasSprites ? toOam(result.sprites) : null;
  const { layout } = result;
  // Create missing folders for every output, e.g. `-e out/title`.
  for (const file of [output, values.export, values.rom].filter(Boolean))
    await mkdir(path.dirname(file), { recursive: true });
  const size = await savePng(result.rgb, output, { scale, aspect, scanlines, layout });
  log(`Wrote ${output} (${size.width}x${size.height})`);

  if (values.export) {
    const base = values.export;
    const files = [[`${base}.chr`, chr], [`${base}.nam`, nam], [`${base}.pal`, pal],
      [`${base}.json`, JSON.stringify(json, null, 2) + '\n']];
    if (oam) files.push([`${base}.oam`, oam]);
    await Promise.all(files.map(([file, data]) => writeFile(file, data)));
    log(`Wrote ${files.map(([file]) => file).join(', ')}`);
  }

  if (values.rom) {
    const rom = toRom(chr, nam, pal, oam);
    await writeFile(values.rom, rom);
    log(`Wrote ${values.rom} (${(rom.length / 1024).toFixed(0)} KB NROM)`);
  }

  log(`Universal background: ${json.universalBackground.hex} (${json.universalBackground.nes})`);
  json.palettes.forEach((p, i) => log(`  palette ${i}: ${p.map((c) => `${c.hex} ${c.nes}`).join('  ')}`));
  log(`Tiles: ${result.tiles.length}${result.reduced ? ` (reduced from ${result.uniqueBefore} unique)` : ''}`);
  if (hasSprites) {
    log(`Sprites: ${result.sprites.length} (${result.spriteTiles.length} sprite tiles)`);
    json.spritePalettes.forEach((p, i) => log(`  sprite palette ${i}: ${p.map((c) => `${c.hex} ${c.nes}`).join('  ')}`));
  }

  // Self-check the rendered screen against the rules, independent of the converter.
  const check = verify(result.rgb, 256, 240, layout);
  report(check);
  log(`Done in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  if (!check.ok) process.exit(1);
}

if (values.help || positionals.length === 0) {
  console.log(HELP);
  process.exit(values.help ? 0 : 2);
}

try {
  if (positionals[0] === 'check') {
    if (!positionals[1]) fail('check needs an image path');
    await runCheck(positionals[1]);
  } else {
    await runConvert(positionals[0]);
  }
} catch (err) {
  fail(err.message);
}

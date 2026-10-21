#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadImage, nesify, savePng } from '../src/index.js';
import { verify } from '../src/verify.js';
import { toChr, toNametable, toPal, toJson } from '../src/export.js';
import { NES_COLORS } from '../src/nes.js';

const HELP = `nesifier - convert an image to a strict NES background

Usage:
  nesifier <input> [options]        convert an image
  nesifier check <image>            verify an image already obeys NES rules

Output:
  -o, --output <file>       preview PNG (default: <input>.nes.png)
  -s, --scale <n>           upscale the preview with nearest-neighbor (default 1)
  -e, --export <base>       write <base>.chr, <base>.nam, <base>.pal, <base>.json

Image fitting:
      --fit <mode>          cover | contain | fill (default cover)
      --resample <kernel>   lanczos3 | nearest | cubic | mitchell (default lanczos3)
      --fill <#hex>         padding color for --fit contain (default #000000)
      --saturation <n>      saturation multiplier before conversion (default 1)
      --brightness <n>      brightness multiplier before conversion (default 1)

Conversion:
  -d, --dither <mode>       none | ordered | fs (default none)
      --strength <0..1>     dither strength (default 0.75)
      --bg <#hex>           force the universal background color
      --bg-candidates <n>   background colors to try when not forced (default 6)
      --max-tiles <n>       unique tile budget, at most 256 (default 256)
  -q, --quiet               only print errors
  -h, --help                show this help

NES rules enforced: 256x240, 8x8 tiles in a 32x30 map, <=256 unique tile patterns
(no flipping), 4 background palettes of 4 colors sharing one universal background
color (<=13 colors total), one palette per 16x16 area, colors from the NES palette.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o' },
    scale: { type: 'string', short: 's', default: '1' },
    export: { type: 'string', short: 'e' },
    fit: { type: 'string', default: 'cover' },
    resample: { type: 'string', default: 'lanczos3' },
    fill: { type: 'string', default: '#000000' },
    saturation: { type: 'string', default: '1' },
    brightness: { type: 'string', default: '1' },
    dither: { type: 'string', short: 'd', default: 'none' },
    strength: { type: 'string', default: '0.75' },
    bg: { type: 'string' },
    'bg-candidates': { type: 'string', default: '6' },
    'max-tiles': { type: 'string', default: '256' },
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
    log(`✓ NES constraints satisfied (${result.stats.colors} colors, ${result.stats.tiles} unique tiles)`);
  } else {
    console.error('✗ NES constraint violations:');
    for (const e of result.errors) console.error(`  - ${e}`);
  }
}

async function runCheck(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = verify(new Uint8Array(data), info.width, info.height);
  report(result);
  if (result.ok && result.stats.palettes)
    result.stats.palettes.forEach((p, i) => log(`  palette ${i}: ${p.map((c) => c ?? '(any)').join(' ')}`));
  process.exit(result.ok ? 0 : 1);
}

async function runConvert(input) {
  const output = values.output ?? path.join(path.dirname(input), path.parse(input).name + '.nes.png');
  const scale = num('scale', { min: 1, max: 16, int: true });
  const t0 = performance.now();

  const rgb = await loadImage(input, {
    fit: oneOf('fit', ['cover', 'contain', 'fill']),
    kernel: oneOf('resample', ['lanczos3', 'nearest', 'cubic', 'mitchell']),
    fill: values.fill,
    saturation: num('saturation', { min: 0, max: 10 }),
    brightness: num('brightness', { min: 0, max: 10 }),
  });

  const result = nesify(rgb, {
    dither: oneOf('dither', ['none', 'ordered', 'fs']),
    strength: num('strength', { min: 0, max: 1 }),
    bg: values.bg,
    bgCandidates: num('bg-candidates', { min: 1, max: NES_COLORS.length, int: true }),
    maxTiles: num('max-tiles', { min: 1, max: 256, int: true }),
  });

  await savePng(result.rgb, output, scale);
  log(`Wrote ${output}${scale > 1 ? ` (${scale}x)` : ''}`);

  if (values.export) {
    const base = values.export;
    await Promise.all([
      writeFile(`${base}.chr`, toChr(result.tiles)),
      writeFile(`${base}.nam`, toNametable(result.nametable, result.assign)),
      writeFile(`${base}.pal`, toPal(result.palettes)),
      writeFile(`${base}.json`, JSON.stringify(toJson(result.palettes, result.tiles.length), null, 2) + '\n'),
    ]);
    log(`Wrote ${base}.chr, ${base}.nam, ${base}.pal, ${base}.json`);
  }

  const json = toJson(result.palettes, result.tiles.length);
  log(`Universal background: ${json.universalBackground.hex} (${json.universalBackground.nes})`);
  json.palettes.forEach((p, i) => log(`  palette ${i}: ${p.map((c) => `${c.hex} ${c.nes}`).join('  ')}`));
  log(`Tiles: ${result.tiles.length}${result.reduced ? ` (reduced from ${result.uniqueBefore} unique)` : ''}`);

  // Self-check the rendered screen against the rules, independent of the converter.
  const check = verify(result.rgb, 256, 240, {
    palettes: json.palettes.map((p) => p.map((c) => c.hex)),
    assign: result.assign,
  });
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

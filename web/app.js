import { ASPECTS, CROPBOXES, LAYOUT_KEY, embedText, parseCropbox, renderPreview } from './src/core.js';

const $ = (id) => document.getElementById(id);
const worker = new Worker('./worker.js', { type: 'module' });
const STORE_KEY = 'nesifier-options';

let result = null;    // latest conversion
let fileName = 'pearl-earring.jpg';
let fileBase = 'pearl-earring';
let jobId = 0, busy = false, pending = false;

// ---------- Options ----------

const DEFAULTS = {
  fit: 'contain', fill: '#000000', pixelArt: true, cropbox: 'small', box: { ...CROPBOXES.small }, letterbox: '#000000', aspect: '4:3', warp: true, dither: 'ordered',
  strength: 0.4, sprites: 64, maxTiles: 128, saturation: 1.75, brightness: 0.85,
};

function readOptions() {
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  return {
    fit: radio('fit'),
    fill: $('fill').value,
    pixelArt: $('pixel-art').checked,
    cropbox: radio('cropbox'),
    box: { x: +$('box-x').value, y: +$('box-y').value, w: +$('box-w').value, h: +$('box-h').value },
    letterbox: $('letterbox').value,
    aspect: radio('aspect'),
    warp: $('warp').checked,
    dither: radio('dither'),
    strength: +$('strength').value,
    sprites: +$('sprites').value,
    maxTiles: +$('max-tiles').value,
    saturation: +$('saturation').value,
    brightness: +$('brightness').value,
  };
}

function applyOptions(o) {
  for (const name of ['fit', 'cropbox', 'aspect', 'dither']) {
    const input = document.querySelector(`input[name="${name}"][value="${o[name]}"]`);
    if (input) input.checked = true;
  }
  $('fill').value = o.fill;
  $('pixel-art').checked = o.pixelArt;
  setBoxInputs(o.box);
  $('letterbox').value = o.letterbox;
  $('warp').checked = o.warp;
  $('strength').value = o.strength;
  $('sprites').value = o.sprites;
  $('max-tiles').value = o.maxTiles;
  $('saturation').value = o.saturation;
  $('brightness').value = o.brightness;
}

function setBoxInputs({ x, y, w, h }) {
  $('box-x').value = x; $('box-y').value = y; $('box-w').value = w; $('box-h').value = h;
}

// The crop box in tiles (null for the whole screen), with custom values clamped onto it.
function cropboxOf(o) {
  if (o.cropbox !== 'custom') return parseCropbox(o.cropbox);
  const int = (v, min, max) => Math.min(max, Math.max(min, Math.round(v) || 0));
  const x = int(o.box.x, 0, 31), y = int(o.box.y, 0, 29);
  return parseCropbox([x, y, int(o.box.w, 1, 32 - x), int(o.box.h, 1, 30 - y)].join(','));
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) applyOptions({ ...DEFAULTS, ...saved });
    if (saved?.cropbox === 'custom') setBoxInputs(cropboxOf(readOptions()) ?? CROPBOXES.full);
  } catch { /* storage unavailable: use defaults */ }
}

function save(o) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

// ---------- Conversion ----------

function convert() {
  if (busy) { pending = true; return; }
  const o = readOptions();
  save(o);
  syncControls(o);
  busy = true;
  $('busy').hidden = false;
  worker.postMessage({
    type: 'convert',
    id: ++jobId,
    opts: { ...o, warp: o.warp ? o.aspect : 'square', cropbox: cropboxOf(o) },
  });
}

let debounce = 0;
const convertSoon = () => { clearTimeout(debounce); debounce = setTimeout(convert, 120); };

worker.onmessage = ({ data }) => {
  busy = false;
  if (pending) { pending = false; convert(); return; } // options changed meanwhile
  $('busy').hidden = true;
  if (data.skipped) return; // no image yet
  if (data.error) { showError(data.error); return; }
  result = data;
  render();
};

worker.onerror = (e) => {
  busy = false;
  $('busy').hidden = true;
  showError(`The converter stopped: ${e.message || 'unknown error'}. This page needs a recent browser.`);
};

async function loadImageFile(blob, name) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // Some browsers can't decode SVG straight to a bitmap; go through an <img>.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      bitmap = await createImageBitmap(img);
    } catch {
      showError(`Couldn't read "${name}". Try a PNG, JPEG, GIF, WebP or SVG image.`);
      return;
    }
    finally { URL.revokeObjectURL(url); }
  }
  fileName = name;
  fileBase = name.replace(/\.[^.]+$/, '') || 'image';
  $('file-name').textContent = `${name} · ${bitmap.width}×${bitmap.height}`;
  worker.postMessage({ type: 'image', bitmap }, [bitmap]);
  convert();
}

async function loadSample() {
  const blob = await (await fetch('pearl-earring.jpg')).blob();
  await loadImageFile(blob, 'pearl-earring.jpg');
}

// ---------- Rendering ----------

function putRgb(canvas, rgb) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(256, 240);
  for (let p = 0, q = 0; q < rgb.length; p += 4, q += 3) {
    img.data[p] = rgb[q]; img.data[p + 1] = rgb[q + 1]; img.data[p + 2] = rgb[q + 2]; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function drawBoxes() {
  const ctx = $('boxes').getContext('2d');
  ctx.clearRect(0, 0, 256, 240);
  ctx.fillStyle = '#ff00ff';
  for (const { x, y } of result.sprites) {
    ctx.fillRect(x, y, 8, 1); ctx.fillRect(x, y + 7, 8, 1);
    ctx.fillRect(x, y, 1, 8); ctx.fillRect(x + 7, y, 1, 8);
  }
}

const swatch = (hex, clear) => `<i style="background:${hex}"${clear ? ' class="clear" title="Transparent"' : ` title="${hex}"`}></i>`;

function render() {
  const o = readOptions();
  putRgb($('out'), result.rgb);
  putRgb($('src'), result.source);
  drawBoxes();

  const { check, json, tiles, uniqueBefore, ms } = result;
  // Only speak up when something is wrong; a valid screen needs no announcement.
  const status = $('status');
  status.hidden = check.ok;
  if (!check.ok) status.innerHTML = `This screen breaks NES rules:<ul>${check.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;

  const meter = (label, value, max, note = '') => `
    <div class="meter">
      <div class="label">${label}</div>
      <div class="value">${value} <small>/ ${max}${note}</small></div>
      <div class="bar"><span style="width:${Math.min(100, (value / max) * 100)}%"></span></div>
    </div>`;
  $('meters').innerHTML =
    meter('Background colors', check.colors ?? '–', 13) +
    meter('Unique tiles', tiles, o.maxTiles, uniqueBefore > tiles ? ` · merged from ${uniqueBefore}` : '') +
    meter('Sprites', result.sprites.length, 64);

  const palRow = (colors, withBg) => `
    <div class="pal"><span class="sw">${colors.map((c, i) => swatch(c.hex, !withBg && i === 0)).join('')}</span>
    <span class="codes">${colors.map((c) => c.nes).join(' ')}</span></div>`;
  $('bg-palettes').innerHTML = json.palettes.map((p) => palRow(p, true)).join('');
  const sp = json.spritePalettes ?? [];
  $('sprite-palette-block').hidden = sp.length === 0;
  $('sprite-palettes').innerHTML = sp.map((p) => palRow([{ hex: 'transparent', nes: '··' }, ...p], false)).join('');

  $('timing').textContent = `${Math.round(ms)} ms`;
  $('dl-oam').disabled = !result.files.oam;
  $('cli').textContent = cliCommand(o);
}

function syncControls(o) {
  $('screen').style.setProperty('--stretch', ASPECTS[o.aspect]);
  $('emu-screen').style.setProperty('--stretch', ASPECTS[o.aspect]);
  $('fill-row').hidden = o.fit !== 'contain';
  $('box-row').hidden = $('box-hint').hidden = o.cropbox !== 'custom';
  $('letterbox-row').hidden = o.cropbox === 'full';
  $('strength-row').hidden = o.dither === 'none';
  $('strength-out').textContent = o.strength.toFixed(2);
  $('sprites-out').textContent = o.sprites;
  $('tiles-out').textContent = o.maxTiles;
  $('saturation-out').textContent = o.saturation.toFixed(2);
  $('brightness-out').textContent = o.brightness.toFixed(2);
  $('warp').closest('label').hidden = o.aspect === 'square';
}

function showError(message) {
  const status = $('status');
  status.hidden = false;
  status.textContent = message;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function cliCommand(o) {
  const quoted = /^[\w.-]+$/.test(fileName) ? fileName : `'${fileName.replace(/'/g, `'\\''`)}'`;
  const args = [`npx nesifier ${quoted}`];
  if (o.fit !== 'cover') args.push(`--fit ${o.fit}`);
  if (o.fit === 'contain' && o.fill !== '#000000') args.push(`--fill '${o.fill}'`);
  if (o.pixelArt) args.push('--resample nearest');
  const box = cropboxOf(o);
  if (box) {
    const preset = Object.keys(CROPBOXES).find((k) => ['x', 'y', 'w', 'h'].every((c) => CROPBOXES[k][c] === box[c]));
    args.push(`--cropbox ${preset ?? [box.x, box.y, box.w, box.h].join(',')}`);
    if (o.letterbox !== '#000000') args.push(`--letterbox '${o.letterbox}'`);
  }
  if (o.aspect !== 'square') args.push(`--aspect ${o.aspect}`);
  if (o.aspect !== 'square' && !o.warp) args.push('--warp square');
  if (o.dither !== 'none') args.push(`-d ${o.dither}`);
  if (o.dither !== 'none' && o.strength !== 0.75) args.push(`--strength ${o.strength}`);
  if (o.sprites !== 64) args.push(`--sprites ${o.sprites}`);
  if (o.maxTiles !== 256) args.push(`--max-tiles ${o.maxTiles}`);
  if (o.saturation !== 1) args.push(`--saturation ${o.saturation}`);
  if (o.brightness !== 1) args.push(`--brightness ${o.brightness}`);
  if ($('show-scanlines').checked) args.push('--scanlines');
  args.push('-s 3', `-r ${fileBase}.nes`);
  return args.join(' ');
}

// ---------- Downloads ----------

function download(data, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function rgbToPngBlob({ data, width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(width, height);
  for (let p = 0, q = 0; q < data.length; p += 4, q += 3) {
    img.data[p] = data[q]; img.data[p + 1] = data[q + 1]; img.data[p + 2] = data[q + 2]; img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function downloadPng() {
  // The exact screen, with the palette layout embedded so `nesifier check` can verify it.
  const blob = await rgbToPngBlob({ data: result.rgb, width: 256, height: 240 });
  const png = embedText(new Uint8Array(await blob.arrayBuffer()), LAYOUT_KEY, JSON.stringify(result.layout));
  download(png, `${fileBase}.nes.png`, 'image/png');
}

async function downloadPreview() {
  const o = readOptions();
  const preview = renderPreview(result.rgb, { scale: 3, aspect: o.aspect, scanlines: $('show-scanlines').checked ? 0.5 : 0 });
  download(await rgbToPngBlob(preview), `${fileBase}.tv.png`);
}

// ---------- Emulator ----------

let emu = null;

function startEmulator() {
  const canvas = $('emu-canvas');
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(256, 240);
  const nes = new window.jsnes.NES({
    onFrame(buffer) {
      for (let p = 0, i = 0; i < buffer.length; i++, p += 4) {
        const v = buffer[i]; // jsnes stores colors as 0xBBGGRR
        img.data[p] = v & 255; img.data[p + 1] = (v >> 8) & 255; img.data[p + 2] = (v >> 16) & 255; img.data[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },
  });
  nes.loadROM(result.files.rom);
  nes.ppu.clipToTvSize = $('emu-overscan').checked;
  let last = 0, raf = 0;
  const tick = (t) => {
    if (t - last >= 1000 / 60 - 1) { last = t; nes.frame(); }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  emu = { nes, stop: () => cancelAnimationFrame(raf) };
}

function stopEmulator() {
  emu?.stop();
  emu = null;
}

// ---------- Events ----------

document.querySelectorAll('.panel input').forEach((input) => {
  if (input.id === 'file') return;
  input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
    syncControls(readOptions());
    convertSoon();
  });
});

// Picking a preset loads it into the custom fields, so Custom starts from it.
document.querySelectorAll('input[name="cropbox"]').forEach((input) => input.addEventListener('change', () => {
  if (input.value !== 'custom') setBoxInputs(CROPBOXES[input.value]);
}));
// Show the custom box as it is used, clamped onto the screen.
document.querySelectorAll('.box-grid input').forEach((input) => input.addEventListener('change', () => {
  setBoxInputs(cropboxOf(readOptions()) ?? CROPBOXES.full);
}));

$('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadImageFile(file, file.name);
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); $('drop-hint').hidden = false; }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => { $('drop-hint').hidden = true; }));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file) loadImageFile(file, file.name);
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (item) loadImageFile(item.getAsFile(), 'pasted.png');
});

// Hold to compare with the fitted source image.
const compare = $('compare');
const showSource = (on) => { $('src').hidden = !on; compare.setAttribute('aria-pressed', on); };
compare.addEventListener('pointerdown', () => showSource(true));
['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => compare.addEventListener(t, () => showSource(false)));
compare.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); showSource(true); } });
compare.addEventListener('keyup', () => showSource(false));

$('show-boxes').addEventListener('change', (e) => { $('boxes').hidden = !e.target.checked; });
// Below 2 screen pixels per NES line the overlay turns into moiré, so only draw it
// when the preview is big enough (the TV preview PNG download always has it).
const updateScanlines = () => {
  $('scanlines').hidden = !$('show-scanlines').checked || $('screen').clientHeight < 480;
};
new ResizeObserver(updateScanlines).observe($('screen'));
$('show-scanlines').addEventListener('change', () => {
  updateScanlines();
  if (result) $('cli').textContent = cliCommand(readOptions());
});

$('dl-rom').addEventListener('click', () => download(result.files.rom, `${fileBase}.nes`));
$('dl-png').addEventListener('click', downloadPng);
$('dl-preview').addEventListener('click', downloadPreview);
for (const ext of ['chr', 'nam', 'pal', 'oam']) {
  $(`dl-${ext}`).addEventListener('click', () => result.files[ext] && download(result.files[ext], `${fileBase}.${ext}`));
}
$('dl-json').addEventListener('click', () => download(JSON.stringify(result.json, null, 2) + '\n', `${fileBase}.json`, 'application/json'));

$('copy-cli').addEventListener('click', async () => {
  const text = $('cli').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('copy-cli').textContent = 'Copied';
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('cli'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    $('copy-cli').textContent = 'Selected';
  }
  setTimeout(() => { $('copy-cli').textContent = 'Copy'; }, 1500);
});

$('play').addEventListener('click', () => {
  if (!result) return;
  if (!window.jsnes) { showError('The emulator failed to load.'); return; }
  $('emu').showModal();
  startEmulator();
});
$('emu-close').addEventListener('click', () => $('emu').close());
$('emu').addEventListener('close', stopEmulator);
$('emu-overscan').addEventListener('change', (e) => { if (emu) emu.nes.ppu.clipToTvSize = e.target.checked; });

loadSaved();
syncControls(readOptions());
loadSample();

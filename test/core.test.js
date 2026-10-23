import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitPlan, renderPreview, modulate } from '../src/core.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('core.js and everything it imports run in a browser', () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(join(SRC, file), 'utf8');
    for (const [, spec] of code.matchAll(/(?:import|export)[^'"]*from\s+'([^']+)'/g)) {
      assert.ok(spec.startsWith('./'), `${file} imports '${spec}', which a browser can't load`);
      visit(spec.slice(2));
    }
    const body = code.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''); // ignore comments
    assert.doesNotMatch(body, /\bBuffer\b|\bprocess\.|require\(/, `${file} uses a Node-only global`);
  };
  visit('core.js');
  assert.ok(seen.size > 5);
});

test('fitPlan crops, pads and warps like the TV will show it', () => {
  // A 2:1 image covering a square-pixel 256x240 screen keeps the full height.
  assert.deepEqual(fitPlan(1000, 500, { fit: 'cover' }), { sx: 233, sy: 0, sw: 533, sh: 500, dx: 0, dy: 0, dw: 256, dh: 240 });
  // Contain centers it with padding above and below.
  const c = fitPlan(1000, 500, { fit: 'contain' });
  assert.equal(c.dw, 256);
  assert.equal(c.dh, 128);
  assert.equal(c.dy, 56);
  // With a 4:3 warp, a square source contained on screen is squeezed to 240 x 0.8.
  const w = fitPlan(600, 600, { fit: 'contain', warp: '4:3' });
  assert.deepEqual([w.dw, w.dh], [192, 240]);
  assert.deepEqual(fitPlan(10, 20, { fit: 'fill' }), { sx: 0, sy: 0, sw: 10, sh: 20, dx: 0, dy: 0, dw: 256, dh: 240 });
});

test('renderPreview scales, stretches and draws scanlines', () => {
  const rgb = new Uint8Array(256 * 240 * 3).fill(200);
  const p = renderPreview(rgb, { scale: 3, aspect: '4:3', scanlines: 0.5 });
  assert.deepEqual([p.width, p.height], [960, 720]);
  const at = (y) => p.data[(y * p.width + 100) * 3];
  assert.deepEqual([at(0), at(1), at(2), at(3)], [200, 200, 100, 200]);
  assert.equal(renderPreview(rgb).data.length, rgb.length);
});

test('modulate scales saturation and brightness', () => {
  const red = Uint8Array.from([200, 40, 40]);
  const grey = modulate(red, { saturation: 0 });
  assert.ok(Math.abs(grey[0] - grey[1]) <= 1 && Math.abs(grey[1] - grey[2]) <= 1, 'no saturation is grey');
  assert.ok(modulate(red, { brightness: 1.3 })[0] > red[0], 'brighter');
  assert.equal(modulate(red), red, 'no-op returns the input');
});

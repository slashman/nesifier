import {
  NES_COLORS, SCREEN_W, SCREEN_H, TILE, MAP_W, MAP_H, ATTR, BLOCKS_W, BLOCKS_H,
  NUM_PALETTES, COLORS_PER_PALETTE, MAX_TILES,
} from './nes.js';

const hex = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();
const LEGAL = new Set(NES_COLORS.map((c) => (c.rgb[0] << 16) | (c.rgb[1] << 8) | c.rgb[2]));
const SLOTS = COLORS_PER_PALETTE - 1;

// Pack per-block color sets (background removed) into <= 4 palettes of <= 3 colors.
function packPalettes(sets) {
  const uniq = [...new Map(sets.filter((s) => s.length).map((s) => [s.join(','), s])).values()];
  const isSubset = (a, b) => a.every((c) => b.includes(c));
  const maximal = uniq.filter((s, i) => !uniq.some((o, j) => j !== i && o.length > s.length && isSubset(s, o)))
    .sort((a, b) => b.length - a.length);
  const pals = [];
  const dfs = (i) => {
    if (i === maximal.length) return true;
    const s = maximal[i];
    for (let p = 0; p < pals.length; p++) {
      const union = [...new Set([...pals[p], ...s])];
      if (union.length > SLOTS) continue;
      const prev = pals[p];
      pals[p] = union;
      if (dfs(i + 1)) return true;
      pals[p] = prev;
    }
    if (pals.length < NUM_PALETTES) {
      pals.push([...s]);
      if (dfs(i + 1)) return true;
      pals.pop();
    }
    return false;
  };
  return dfs(0) ? pals : null;
}

/**
 * Check an RGB image against strict NES background rules. Tile patterns depend on the
 * order of colors inside each palette, so callers that know the real arrangement can
 * pass `layout` = { palettes: [[#hex x4] x4], assign: block -> palette } to count them
 * exactly; otherwise a valid arrangement is derived.
 */
export function verify(rgb, width, height, layout = null) {
  const errors = [];
  if (width !== SCREEN_W || height !== SCREEN_H) {
    errors.push(`Resolution is ${width}x${height}, expected ${SCREEN_W}x${SCREEN_H}`);
    return { ok: false, errors };
  }

  const px = new Int32Array(SCREEN_W * SCREEN_H);
  const illegal = new Map();
  for (let p = 0; p < px.length; p++) {
    px[p] = (rgb[p * 3] << 16) | (rgb[p * 3 + 1] << 8) | rgb[p * 3 + 2];
    if (!LEGAL.has(px[p])) illegal.set(px[p], (illegal.get(px[p]) || 0) + 1);
  }
  if (illegal.size) {
    const list = [...illegal.keys()].slice(0, 8).map(hex).join(' ');
    errors.push(`${illegal.size} color(s) not in the NES palette: ${list}${illegal.size > 8 ? ' ...' : ''}`);
  }

  const blockSets = [];
  for (let by = 0; by < BLOCKS_H; by++) {
    for (let bx = 0; bx < BLOCKS_W; bx++) {
      const s = new Set();
      for (let y = by * ATTR; y < (by + 1) * ATTR; y++)
        for (let x = bx * ATTR; x < (bx + 1) * ATTR; x++) s.add(px[y * SCREEN_W + x]);
      blockSets.push([...s].sort((a, b) => a - b));
    }
  }
  const crowded = blockSets.filter((s) => s.length > COLORS_PER_PALETTE).length;
  if (crowded) errors.push(`${crowded} 16x16 area(s) use more than ${COLORS_PER_PALETTE} colors`);

  const allColors = [...new Set(px)];
  const total = allColors.length;
  if (total > 1 + NUM_PALETTES * SLOTS) errors.push(`${total} colors on screen, maximum is ${1 + NUM_PALETTES * SLOTS}`);

  let solution = null;
  if (layout && !crowded) {
    const toInt = (h) => parseInt(h.slice(1), 16);
    const pals = layout.palettes.map((p) => p.slice(1).map(toInt));
    const bg = toInt(layout.palettes[0][0]);
    const sets = blockSets.map((s) => s.filter((c) => c !== bg));
    const bad = sets.filter((s, b) => !s.every((c) => pals[layout.assign[b]].includes(c))).length;
    if (layout.palettes.some((p) => p[0] !== layout.palettes[0][0])) errors.push('Palettes do not share one universal background color');
    if (bad) errors.push(`${bad} 16x16 area(s) use colors outside their assigned palette`);
    else solution = { bg, pals, sets, blockPalIdx: [...layout.assign] };
  } else if (!crowded) {
    // The universal background color must belong to every block that uses all 4 slots.
    let cands = allColors;
    for (const s of blockSets) if (s.length === COLORS_PER_PALETTE) cands = cands.filter((c) => s.includes(c));
    if (!blockSets.some((s) => s.length === COLORS_PER_PALETTE)) cands = [...cands, -1];
    for (const bg of cands) {
      const sets = blockSets.map((s) => s.filter((c) => c !== bg));
      const pals = packPalettes(sets);
      if (pals) { solution = { bg, pals, sets }; break; }
    }
    if (!solution) errors.push(`Block colors cannot be arranged into ${NUM_PALETTES} palettes sharing one background color`);
  }

  let tileCount = null;
  if (solution) {
    const { bg, pals, sets } = solution;
    const palIdx = solution.blockPalIdx ??
      sets.map((s) => Math.max(0, pals.findIndex((p) => s.every((c) => p.includes(c)))));
    const NT = MAP_W * MAP_H;
    const tilePal = new Uint8Array(NT);
    const slots = new Uint8Array(NT * TILE * TILE);
    for (let t = 0; t < NT; t++) {
      const tx = t % MAP_W, ty = (t / MAP_W) | 0;
      tilePal[t] = palIdx[((ty * TILE / ATTR) | 0) * BLOCKS_W + ((tx * TILE / ATTR) | 0)];
      for (let i = 0; i < TILE * TILE; i++) {
        const c = px[(ty * TILE + (i >> 3)) * SCREEN_W + tx * TILE + (i & 7)];
        slots[t * 64 + i] = c === bg ? 0 : pals[tilePal[t]].indexOf(c) + 1;
      }
    }

    // Tile patterns depend on the color order inside each palette. With a known layout
    // that order is fixed; otherwise try every order (3! per palette) and keep the best.
    const PERMS = [[0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 2, 3, 1], [0, 3, 1, 2], [0, 3, 2, 1]];
    const combos = layout ? 1 : PERMS.length ** pals.length;
    let best = { count: Infinity, combo: 0 };
    const key = Buffer.alloc(64);
    for (let combo = 0; combo < combos; combo++) {
      const perm = pals.map((_, p) => PERMS[Math.floor(combo / PERMS.length ** p) % PERMS.length]);
      const patterns = new Set();
      for (let t = 0; t < NT; t++) {
        const m = perm[tilePal[t]];
        for (let i = 0; i < 64; i++) key[i] = m[slots[t * 64 + i]];
        patterns.add(key.toString('latin1'));
      }
      if (patterns.size < best.count) best = { count: patterns.size, perm };
      if (best.count <= MAX_TILES) break;
    }
    tileCount = best.count;
    if (tileCount > MAX_TILES) errors.push(`${tileCount} unique 8x8 tile patterns, maximum is ${MAX_TILES}`);
    solution.palettes = pals.map((p, i) => {
      const ordered = [null, null, null];
      p.forEach((c, j) => { ordered[best.perm[i][j + 1] - 1] = hex(c); });
      return [bg === -1 ? null : hex(bg), ...ordered];
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: { colors: total, tiles: tileCount, palettes: solution?.palettes ?? null },
  };
}

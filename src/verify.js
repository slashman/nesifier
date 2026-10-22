import {
  NES_COLORS, SCREEN_W, SCREEN_H, TILE, MAP_W, MAP_H, ATTR, BLOCKS_W, BLOCKS_H,
  NUM_PALETTES, COLORS_PER_PALETTE, MAX_TILES,
} from './nes.js';

const hex = (n) => '#' + n.toString(16).padStart(6, '0').toUpperCase();
const LEGAL = new Set(NES_COLORS.map((c) => (c.rgb[0] << 16) | (c.rgb[1] << 8) | c.rgb[2]));
const SLOTS = COLORS_PER_PALETTE - 1;
const WILD = -2; // a background pixel hidden under a sprite: it can be any color
const MAX_SPRITES = 64, SPRITES_PER_LINE = 8;

/**
 * Check `layout.sprites` ({ palettes: [[#hex x3]], list: [{ x, y, palette, pattern }] })
 * against the sprite rules and the image. Opaque sprite pixels must show their sprite's
 * color (the first sprite in the list wins, as in OAM); they are then marked WILD so the
 * background rules only see what the background really shows.
 */
function checkSprites(px, sprites, errors) {
  const { palettes, list } = sprites;
  if (!Array.isArray(palettes) || palettes.length > 4 || !Array.isArray(list)) {
    errors.push('Malformed sprite layout');
    return;
  }
  for (const p of palettes) {
    if (p.length !== 3 || p.some((c) => !LEGAL.has(parseInt(String(c).slice(1), 16)))) {
      errors.push('Sprite palettes must have 3 NES colors each');
      return;
    }
  }
  if (list.length > MAX_SPRITES) errors.push(`${list.length} sprites, maximum is ${MAX_SPRITES}`);
  const perLine = new Uint8Array(SCREEN_H);
  const claimed = new Uint8Array(SCREEN_W * SCREEN_H);
  let mismatched = 0;
  for (const s of list) {
    const okShape = Number.isInteger(s.x) && Number.isInteger(s.y) && s.x >= 0 && s.x <= SCREEN_W - TILE &&
      s.y >= 1 && s.y <= SCREEN_H - TILE && Number.isInteger(s.palette) && s.palette >= 0 &&
      s.palette < palettes.length && /^[0-3]{64}$/.test(s.pattern);
    if (!okShape) { errors.push('Malformed sprite in layout'); return; }
    for (let dy = 0; dy < TILE; dy++) perLine[s.y + dy]++;
    for (let i = 0; i < 64; i++) {
      const v = +s.pattern[i];
      const p = (s.y + (i >> 3)) * SCREEN_W + s.x + (i & 7);
      if (!v || claimed[p]) continue; // transparent, or hidden by an earlier sprite
      claimed[p] = 1;
      if (px[p] !== parseInt(palettes[s.palette][v - 1].slice(1), 16)) mismatched++;
      px[p] = WILD;
    }
  }
  const busy = perLine.filter((n) => n > SPRITES_PER_LINE).length;
  if (busy) errors.push(`${busy} scanline(s) have more than ${SPRITES_PER_LINE} sprites`);
  if (mismatched) errors.push(`${mismatched} pixel(s) don't match the sprite drawn over them`);
}

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
 * Hill-climb toward fewer unique tiles: an area whose colors fit several palettes can
 * switch between them, and each palette's color order can change. Pattern reference
 * counts make each move cheap to evaluate.
 */
function refineLayout(px, bg, pals, sets, palIdx, startPerm, PERMS) {
  const assign = [...palIdx];
  const perm = startPerm.map((m) => [...m]);
  const options = sets.map((s) => pals.map((_, p) => p).filter((p) => s.every((c) => pals[p].includes(c))));
  const tilesOf = (b) => {
    const tx = (b % BLOCKS_W) * 2, ty = ((b / BLOCKS_W) | 0) * 2;
    return [ty * MAP_W + tx, ty * MAP_W + tx + 1, (ty + 1) * MAP_W + tx, (ty + 1) * MAP_W + tx + 1];
  };
  const key = Buffer.alloc(64);
  const keyFor = (t, p) => {
    const tx = t % MAP_W, ty = (t / MAP_W) | 0, m = perm[p];
    for (let i = 0; i < 64; i++) {
      const c = px[(ty * TILE + (i >> 3)) * SCREEN_W + tx * TILE + (i & 7)];
      key[i] = c === bg ? 0 : m[pals[p].indexOf(c) + 1];
    }
    return key.toString('latin1');
  };
  const counts = new Map();
  const add = (b) => { for (const t of tilesOf(b)) { const k = keyFor(t, assign[b]); counts.set(k, (counts.get(k) || 0) + 1); } };
  const remove = (b) => {
    for (const t of tilesOf(b)) {
      const k = keyFor(t, assign[b]), n = counts.get(k) - 1;
      if (n) counts.set(k, n); else counts.delete(k);
    }
  };
  const blocks = sets.map((_, b) => b);
  blocks.forEach(add);

  for (let round = 0, improved = true; improved && counts.size > MAX_TILES && round < 50; round++) {
    improved = false;
    for (const b of blocks) {
      for (const p of options[b]) {
        if (p === assign[b]) continue;
        const before = counts.size, old = assign[b];
        remove(b); assign[b] = p; add(b);
        if (counts.size < before) improved = true;
        else { remove(b); assign[b] = old; add(b); }
      }
    }
    for (let p = 0; p < pals.length; p++) {
      const members = blocks.filter((b) => assign[b] === p);
      for (const next of PERMS) {
        const before = counts.size, old = perm[p];
        members.forEach(remove); perm[p] = next; members.forEach(add);
        if (counts.size < before) improved = true;
        else { members.forEach(remove); perm[p] = old; members.forEach(add); }
      }
    }
  }
  return { count: counts.size, perm };
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
  if (layout?.sprites) checkSprites(px, layout.sprites, errors);

  const blockSets = [];
  for (let by = 0; by < BLOCKS_H; by++) {
    for (let bx = 0; bx < BLOCKS_W; bx++) {
      const s = new Set();
      for (let y = by * ATTR; y < (by + 1) * ATTR; y++)
        for (let x = bx * ATTR; x < (bx + 1) * ATTR; x++) if (px[y * SCREEN_W + x] !== WILD) s.add(px[y * SCREEN_W + x]);
      blockSets.push([...s].sort((a, b) => a - b));
    }
  }
  const crowded = blockSets.filter((s) => s.length > COLORS_PER_PALETTE).length;
  if (crowded) errors.push(`${crowded} 16x16 area(s) use more than ${COLORS_PER_PALETTE} colors`);

  const allColors = [...new Set(px)].filter((c) => c !== WILD);
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
        slots[t * 64 + i] = c === WILD ? 255 : c === bg ? 0 : pals[tilePal[t]].indexOf(c) + 1;
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
      const partial = [];
      for (let t = 0; t < NT; t++) {
        const m = perm[tilePal[t]];
        let hidden = false;
        for (let i = 0; i < 64; i++) {
          const s = slots[t * 64 + i];
          if (s === 255) hidden = true;
          key[i] = s === 255 ? 255 : m[s];
        }
        if (hidden) partial.push(Buffer.from(key));
        else patterns.add(key.toString('latin1'));
      }
      // A tile partly hidden by sprites can reuse any full pattern that agrees with every
      // visible pixel. Otherwise it shares a new pattern with other partly hidden tiles
      // whose visible pixels never disagree, filling in each other's unknowns. Every
      // tile agrees with the pattern it ends up using, so this never undercounts and an
      // image can't pass unless a valid tile set exists.
      const full = [...patterns].map((k) => Buffer.from(k, 'latin1'));
      const shared = [];
      const known = (k) => k.reduce((n, v) => n + (v !== 255), 0);
      partial.sort((a, b) => known(b) - known(a));
      for (const k of partial) {
        if (full.some((q) => k.every((v, i) => v === 255 || v === q[i]))) continue;
        const q = shared.find((q) => k.every((v, i) => v === 255 || q[i] === 255 || v === q[i]));
        if (q) k.forEach((v, i) => { if (v !== 255) q[i] = v; });
        else shared.push(Buffer.from(k));
      }
      const count = patterns.size + shared.length;
      if (count < best.count) best = { count, perm };
      if (best.count <= MAX_TILES) break;
    }
    if (!layout && best.count > MAX_TILES) best = refineLayout(px, bg, pals, sets, palIdx, best.perm, PERMS);
    tileCount = best.count;
    if (tileCount > MAX_TILES) {
      errors.push(layout
        ? `${tileCount} unique 8x8 tile patterns, maximum is ${MAX_TILES}`
        : `No palette arrangement found with <= ${MAX_TILES} unique tiles (best: ${tileCount}); ` +
          'the image may still be valid with a different arrangement');
    }
    solution.palettes = pals.map((p, i) => {
      const ordered = [null, null, null];
      p.forEach((c, j) => { ordered[best.perm[i][j + 1] - 1] = hex(c); });
      return [bg === -1 ? null : hex(bg), ...ordered];
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: { colors: total, tiles: tileCount, palettes: solution?.palettes ?? null, sprites: layout?.sprites?.list?.length ?? 0 },
  };
}

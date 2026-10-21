import { crc32 } from 'node:zlib';

// Minimal PNG tEXt chunk support, used to store the palette layout alongside the
// preview so `nesifier check` can verify our own output exactly.
const SIG = 8;

function chunks(buf) {
  const out = [];
  for (let o = SIG; o + 12 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    out.push({ type: buf.toString('latin1', o + 4, o + 8), start: o, data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

export function embedText(png, keyword, text) {
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  const iend = chunks(png).find((c) => c.type === 'IEND').start;
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)]);
}

export function readText(png, keyword) {
  if (png.length < SIG || png.toString('latin1', 1, 4) !== 'PNG') return null;
  for (const c of chunks(png)) {
    if (c.type !== 'tEXt') continue;
    const nul = c.data.indexOf(0);
    if (nul > 0 && c.data.toString('latin1', 0, nul) === keyword) return c.data.toString('latin1', nul + 1);
  }
  return null;
}

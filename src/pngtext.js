// Minimal PNG tEXt chunk support, used to store the palette layout alongside the
// preview so `nesifier check` can verify our own output exactly. Plain Uint8Arrays,
// so it runs in browsers as well as Node.
const SIG = 8;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return s;
};
const fromLatin1 = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);

function chunks(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  for (let o = SIG; o + 12 <= png.length;) {
    const len = view.getUint32(o);
    out.push({ type: latin1(png.subarray(o + 4, o + 8)), start: o, data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

export function embedText(png, keyword, text) {
  const data = fromLatin1(`${keyword}\0${text}`);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(fromLatin1('tEXt'), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const iend = chunks(png).find((c) => c.type === 'IEND').start;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, iend), 0);
  out.set(chunk, iend);
  out.set(png.subarray(iend), iend + chunk.length);
  return out;
}

export function readText(png, keyword) {
  if (png.length < SIG || latin1(png.subarray(1, 4)) !== 'PNG') return null;
  for (const c of chunks(png)) {
    if (c.type !== 'tEXt') continue;
    const nul = c.data.indexOf(0);
    if (nul > 0 && latin1(c.data.subarray(0, nul)) === keyword) return latin1(c.data.subarray(nul + 1));
  }
  return null;
}

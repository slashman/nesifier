// Build a minimal NROM (mapper 0) .nes file that displays one background screen, with
// optional sprites. Layout of the 16 KB PRG bank, mapped at $C000 (mirrored at $8000):
//   $C000  startup code      $C100  32 palette bytes
//   $C200  nametable + attributes (1024 bytes)
//   $C600  sprite table (256 bytes of OAM, copied to the PPU every vblank by DMA)
//   $FFFA  NMI / RESET / IRQ vectors
const PRG_SIZE = 0x4000;
const CHR_SIZE = 0x2000;
const ORG = 0xc000;
const PAL_ADDR = 0xc100;
const NAM_ADDR = 0xc200;
const OAM_ADDR = 0xc600;

// Tiny 6502 assembler: just the opcodes this program needs. Labels resolve in a
// second pass so branch offsets are computed, not hand-counted.
function assemble(program) {
  const OPS = {
    sei: [0x78], cld: [0xd8], txs: [0x9a], inx: [0xe8], iny: [0xc8], dex: [0xca], rti: [0x40],
    pha: [0x48], pla: [0x68],
    'ldx#': [0xa2, 1], 'lda#': [0xa9, 1], 'ldy#': [0xa0, 1], 'cpx#': [0xe0, 1],
    stx: [0x8e, 2], sta: [0x8d, 2], lda: [0xad, 2], bit: [0x2c, 2], jmp: [0x4c, 2],
    'lda,x': [0xbd, 2], 'sta.zp': [0x85, 1], 'inc.zp': [0xe6, 1], 'lda(zp),y': [0xb1, 1],
    bpl: [0x10, 'rel'], bne: [0xd0, 'rel'],
  };
  const labels = {};
  const sizeOf = (op) => 1 + (OPS[op][1] === 'rel' ? 1 : OPS[op][1] || 0);
  let pc = ORG;
  for (const ins of program) {
    if (typeof ins === 'string') labels[ins] = pc;
    else pc += sizeOf(ins[0]);
  }
  const out = [];
  pc = ORG;
  for (const ins of program) {
    if (typeof ins === 'string') continue;
    const [op, arg] = ins;
    const [code, mode] = OPS[op];
    const value = typeof arg === 'string' ? labels[arg] : arg;
    pc += sizeOf(op);
    out.push(code);
    if (mode === 'rel') {
      const off = value - pc;
      if (off < -128 || off > 127) throw new Error(`Branch to ${arg} out of range`);
      out.push(off & 0xff);
    } else if (mode === 1) out.push(value & 0xff);
    else if (mode === 2) out.push(value & 0xff, value >> 8);
  }
  return { bytes: Uint8Array.from(out), labels };
}

// With sprites: PPUCTRL $88 enables the vblank NMI and puts sprite patterns at $1000,
// and PPUMASK $1E shows sprites too. Without: $00 and $0E (background only).
const program = (sprites) => [
  'reset',
  ['sei'], ['cld'],
  ['ldx#', 0xff], ['txs'], ['inx'],      // stack at $01FF, X = 0
  ['stx', 0x2000], ['stx', 0x2001],      // NMI and rendering off
  ['stx', 0x4010],                       // DMC IRQ off
  ['lda#', 0x40], ['sta', 0x4017],       // APU frame IRQ off
  // The PPU ignores writes until it has warmed up: wait two vblanks.
  'vblank1', ['bit', 0x2002], ['bpl', 'vblank1'],
  'vblank2', ['bit', 0x2002], ['bpl', 'vblank2'],

  // Palettes: 32 bytes to $3F00.
  ['lda', 0x2002],                       // reset the address latch
  ['lda#', 0x3f], ['sta', 0x2006], ['lda#', 0x00], ['sta', 0x2006],
  ['ldx#', 0],
  'pal', ['lda,x', PAL_ADDR], ['sta', 0x2007], ['inx'], ['cpx#', 32], ['bne', 'pal'],

  // Nametable 0 and its attribute table: 4 pages to $2000.
  ['lda#', 0x20], ['sta', 0x2006], ['lda#', 0x00], ['sta', 0x2006],
  ['lda#', NAM_ADDR & 0xff], ['sta.zp', 0x00], ['lda#', NAM_ADDR >> 8], ['sta.zp', 0x01],
  ['ldx#', 4], ['ldy#', 0],
  'nam', ['lda(zp),y', 0x00], ['sta', 0x2007], ['iny'], ['bne', 'nam'],
  ['inc.zp', 0x01], ['dex'], ['bne', 'nam'],

  // First sprite table copy, so sprites show from the first frame.
  ...(sprites ? [['lda#', OAM_ADDR >> 8], ['sta', 0x4014]] : []),

  // Scroll 0,0; nametable $2000, background patterns at $0000.
  ['lda#', 0], ['sta', 0x2005], ['sta', 0x2005],
  ['lda#', sprites ? 0x88 : 0x00], ['sta', 0x2000],
  // Turn on rendering during vblank. Bits 1-2 unhide the leftmost 8 pixels for
  // background and sprites; without sprites the sprite bit still matters, because some
  // emulators clip the background column whenever it is clear.
  'vblank3', ['bit', 0x2002], ['bpl', 'vblank3'],
  ['lda#', sprites ? 0x1e : 0x0e], ['sta', 0x2001],
  'forever', ['jmp', 'forever'],

  // Sprite memory fades unless it is refreshed, so copy the table every vblank.
  'nmi', ...(sprites ? [['pha'], ['lda#', OAM_ADDR >> 8], ['sta', 0x4014], ['pla']] : []),
  'irq', ['rti'],
];

/**
 * @param chr 4 KB background pattern table, or 8 KB with sprite patterns (toChr)
 * @param nam 1024-byte nametable + attribute table (toNametable)
 * @param pal 16-byte background palette, or 32 bytes with sprite palettes (toPal)
 * @param oam optional 256-byte sprite table (toOam)
 */
export function toRom(chr, nam, pal, oam = null) {
  const { bytes, labels } = assemble(program(Boolean(oam)));
  if (ORG + bytes.length > PAL_ADDR) throw new Error('Startup code overlaps palette data');

  const header = Uint8Array.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const prg = new Uint8Array(PRG_SIZE);
  prg.set(bytes, 0);
  // Without sprite palettes, repeat the background ones: $3F10 mirrors $3F00, so its
  // entry must be the universal background color or it would overwrite it.
  prg.set(pal, PAL_ADDR - ORG);
  if (pal.length === 16) prg.set(pal, PAL_ADDR - ORG + 16);
  prg.set(nam, NAM_ADDR - ORG);
  if (oam) prg.set(oam, OAM_ADDR - ORG);
  const vec = (off, addr) => { prg[off] = addr & 0xff; prg[off + 1] = addr >> 8; };
  vec(0x3ffa, labels.nmi); // only enabled with sprites; otherwise it falls through to RTI
  vec(0x3ffc, labels.reset);
  vec(0x3ffe, labels.irq);

  const chrRom = new Uint8Array(CHR_SIZE); // second 4 KB holds sprite patterns, if any
  chrRom.set(chr, 0);

  const rom = new Uint8Array(16 + PRG_SIZE + CHR_SIZE);
  rom.set(header, 0);
  rom.set(prg, 16);
  rom.set(chrRom, 16 + PRG_SIZE);
  return rom;
}

// ref-machine.mjs — set up the JS reference 8086 emulator (`tools/js8086.js`)
// to run the *same* bytes the calcite cabinet runs.
//
// The cabinet builder writes sidecar .bin files alongside each .css:
//   <cabinet>.bios.bin     — the BIOS bytes that ended up in the cabinet
//                            (post patchBiosMemSize / patchBiosStackSeg)
//   <cabinet>.disk.bin     — FAT12 floppy (DOS preset only)
//   <cabinet>.kernel.bin   — kernel.sys bytes (DOS preset only)
//   <cabinet>.program.bin  — .COM bytes (hack preset only)
//   <cabinet>.meta.json    — the harness header payload
//
// This module loads those sidecars, lays out a 1 MB memory image matching
// the cabinet's layout, and returns a stepping interface.
//
// The emulator is the authoritative reference for every register + flag.
// Divergence against this machine = calcite or CSS bug (never emulator bug).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_DOS_ROOT = resolve(__dirname, '..', '..', '..');

// Load js8086 once; re-use the closure across setups.
let Intel8086;
function loadIntel8086() {
  if (Intel8086) return Intel8086;
  const src = readFileSync(resolve(CSS_DOS_ROOT, 'tools', 'js8086.js'), 'utf-8');
  // js8086 uses "let CPU_186 = 0" — flipping it to 1 enables 80186 ops
  // (BOUND, ENTER/LEAVE, PUSH imm, IMUL imm, etc.) which most DOS
  // programs in this project rely on.
  const evalSource = src.replace("'use strict';", '').replace('let CPU_186 = 0;', 'var CPU_186 = 1;');
  Intel8086 = new Function(evalSource + '\nreturn Intel8086;')();
  return Intel8086;
}

let peripheralsModule;
async function importPeripherals() {
  if (peripheralsModule) return peripheralsModule;
  const { pathToFileURL } = await import('node:url');
  peripheralsModule = await import(pathToFileURL(resolve(CSS_DOS_ROOT, 'tools', 'peripherals.mjs')).href);
  return peripheralsModule;
}
// Sync path for createRefMachine. Uses Node's dynamic `require` semantics
// via the `module` builtin so the ESM loader's cache still applies.
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
let peripheralsSync;
function loadPeripherals() {
  if (peripheralsSync) return peripheralsSync;
  // peripherals.mjs is ESM — can't use require directly. Inline-eval
  // the source in a fresh function so ES export/import become regular
  // module.exports plumbing. Simpler alternative is to require callers
  // to pre-await an initRefMachine() helper; we go sync by reading the
  // file and turning its exports into a module-like record.
  const src = readFileSync(resolve(CSS_DOS_ROOT, 'tools', 'peripherals.mjs'), 'utf-8');
  // The module only uses 'export class', has no top-level await, no
  // other imports. Strip `export ` and evaluate as a CommonJS-style
  // snippet that returns the class set.
  const body = src.replace(/export\s+class\s+(\w+)/g, 'class $1').replace(/^\s*export\s+/gm, '');
  peripheralsSync = new Function(body + '\nreturn { PIC, PIT, KeyboardController };')();
  return peripheralsSync;
}

// Load every sidecar known to the cabinet. Returns { bios, disk, program,
// kernel, meta } with present/absent keys set based on preset.
export function loadCabinetSidecars(cssPath) {
  const base = cssPath.replace(/\.css$/, '');
  const metaPath = `${base}.meta.json`;
  if (!existsSync(metaPath)) {
    throw new Error(`no sidecar meta at ${metaPath} — this cabinet was built before the harness-header upgrade; rebuild with \`node builder/build.mjs ${cssPath.replace(/\.css$/, '')}\``);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const out = { meta, cssPath };
  for (const part of ['bios', 'disk', 'program', 'kernel']) {
    const p = `${base}.${part}.bin`;
    if (existsSync(p)) out[part] = new Uint8Array(readFileSync(p));
  }
  if (!out.bios) throw new Error(`cabinet missing BIOS sidecar ${base}.bios.bin`);
  return out;
}

// Build the 1 MB memory image the emulator will run against. Layout
// mirrors what kiln emits into the cabinet:
//   0x00000-0x00400   IVT (256 entries × 4 bytes = 0x400)
//   0x00400-0x00600   BDA scratch (most fields populated by corduroy's
//                     install_bda during BIOS boot — we don't pre-fill)
//   0x00600+          kernel (DOS) or empty (hack)
//   0xD0000+          disk image (DOS rom-disk; hack has none)
//   0xF0000+          BIOS
//   0xFFFF0           reset vector (BIOS) — supplied by BIOS bytes
//
// For hack preset, the .COM goes to 0x100 (CS:IP = 0:0x100) and we don't
// load the kernel or disk.
//
// We set IVT entries to point into the BIOS only for carts where the
// cabinet itself seeds IVT via embeddedData (hack preset). For DOS carts,
// the BIOS installs its own IVT during boot — leave it zero, BIOS will
// write to it at runtime.
export function buildMemoryImage(sidecars) {
  const mem = new Uint8Array(1024 * 1024);
  const { bios, disk, kernel, program, meta } = sidecars;

  // BIOS always lives at 0xF0000.
  mem.set(bios, 0xF0000);

  if (meta.preset === 'hack') {
    // Hack cart: .COM at 0x100. IVT handled by kiln-embedded data that the
    // cabinet materialises — we need to replicate it. Standard gossamer
    // handlers (from kiln/memory.mjs BIOS_IVT_HANDLERS):
    //   INT 10h → F000:0000 (video)
    //   INT 16h → F000:0155 (keyboard)
    //   INT 1Ah → F000:0190 (timer)
    //   INT 20h → F000:023D (terminate)
    //   INT 21h → F000:01A9 (DOS services)
    // Other vectors point to F000:0000 (IRET stub) by default.
    const HANDLERS = { 0x10: 0x0000, 0x16: 0x0155, 0x1A: 0x0190, 0x20: 0x023D, 0x21: 0x01A9 };
    // Default every vector to F000:0000.
    for (let i = 0; i < 256; i++) {
      mem[i * 4 + 0] = 0;
      mem[i * 4 + 1] = 0;
      mem[i * 4 + 2] = 0x00;
      mem[i * 4 + 3] = 0xF0;
    }
    for (const [n, off] of Object.entries(HANDLERS)) {
      const i = parseInt(n);
      mem[i * 4 + 0] = off & 0xFF;
      mem[i * 4 + 1] = (off >> 8) & 0xFF;
      mem[i * 4 + 2] = 0x00;
      mem[i * 4 + 3] = 0xF0;
    }
    if (!program) throw new Error('hack cart missing program sidecar');
    mem.set(program, 0x100);
  } else {
    // DOS cart: load kernel at 0x600, disk at 0xD0000. Corduroy's entry
    // stub runs first (at entrySegment:entryOffset = F000:0000) and
    // initializes IVT, BDA, timer, PIC, etc. from its install_bda code.
    if (kernel) mem.set(kernel, 0x600);
    if (disk)   mem.set(disk, 0xD0000);
  }

  return mem;
}

// Construct a stepping emulator. Returns { cpu, mem, step, reset, regs }.
// `regs()` returns a plain-object snapshot of every standard register
// plus FLAGS in one shape matching the calcite debugger's /state output,
// so cross-machine diffs don't need translation logic.
//
// `peripherals` option: 'real' wires the full PIC + PIT from tools/peripherals.mjs
// (matches calcite's behaviour during DOS boot), 'stub' gives dummies that
// never fire. Default: 'real' — you almost always want the timer ticking.
export function createRefMachine(sidecars, { initialCS, initialIP, peripherals = 'real' } = {}) {
  const Intel8086 = loadIntel8086();
  const mem = buildMemoryImage(sidecars);

  // Writes during a single step accumulate here, then the caller can
  // drain them between steps. Each entry: { addr, value }. Opt-in — only
  // populated when writeLog is non-null.
  let writeLog = null;

  const read = (addr) => {
    if (addr < 0 || addr >= mem.length) return 0;
    return mem[addr];
  };
  const write = (addr, val) => {
    if (addr < 0 || addr >= mem.length) return;
    mem[addr] = val & 0xFF;
    if (writeLog) writeLog.push({ addr, value: val & 0xFF });
  };

  let pic, pit;
  if (peripherals === 'real') {
    const { PIC, PIT } = loadPeripherals();
    pic = new PIC();
    pit = new PIT(pic);
  } else {
    const stub = {
      isConnected: () => false,
      hasInt: () => false,
      tick: () => undefined,
      nextInt: () => 0,
      portIn: () => 0,
      portOut: () => undefined,
    };
    pic = stub; pit = stub;
  }

  const cpu = Intel8086(write, read, pic, pit, null);
  cpu.reset();

  // Reset-vector convention on real 8086: CS=FFFF, IP=0000, so execution
  // starts at 0xFFFF0, where a 16-byte "far jump" stub lives in the BIOS.
  // If caller provided initialCS/IP (e.g. from the harness header's
  // bios.entrySegment/Offset), honour that instead — matches what the
  // cabinet's initialCS/IP setters pass into calcite.
  if (initialCS != null && initialIP != null) {
    cpu.setRegs({ cs: initialCS & 0xFFFF, ip: initialIP & 0xFFFF });
  }

  // Helper to overwrite every tracked register at once. Used by fulldiff
  // to align the ref with calcite's post-kiln initial state (SP, SS, etc.
  // are pre-set by the emitted CSS).
  const applyRegs = (r) => {
    const low = (v) => v & 0xFF;
    const high = (v) => (v >> 8) & 0xFF;
    const upd = {};
    if (r.AX != null) { upd.ah = high(r.AX); upd.al = low(r.AX); }
    if (r.BX != null) { upd.bh = high(r.BX); upd.bl = low(r.BX); }
    if (r.CX != null) { upd.ch = high(r.CX); upd.cl = low(r.CX); }
    if (r.DX != null) { upd.dh = high(r.DX); upd.dl = low(r.DX); }
    if (r.SI != null) upd.si = r.SI & 0xFFFF;
    if (r.DI != null) upd.di = r.DI & 0xFFFF;
    if (r.BP != null) upd.bp = r.BP & 0xFFFF;
    if (r.SP != null) upd.sp = r.SP & 0xFFFF;
    if (r.CS != null) upd.cs = r.CS & 0xFFFF;
    if (r.DS != null) upd.ds = r.DS & 0xFFFF;
    if (r.ES != null) upd.es = r.ES & 0xFFFF;
    if (r.SS != null) upd.ss = r.SS & 0xFFFF;
    if (r.IP != null) upd.ip = r.IP & 0xFFFF;
    if (r.FLAGS != null) upd.flags = r.FLAGS & 0xFFFF;
    cpu.setRegs(upd);
  };

  return {
    cpu,
    mem,
    step: () => cpu.step(),
    regs: () => snapshotRegs(cpu),
    applyRegs,
    // Enable/disable a per-step write log. Returns the current log and
    // resets it. Useful for fulldiff-style "what did the ref just write?"
    beginWriteLog: () => { writeLog = []; },
    drainWriteLog: () => { const r = writeLog ?? []; writeLog = writeLog ? [] : null; return r; },
    stopWriteLog: () => { writeLog = null; },
  };
}

// Mirror the calcite debugger's /state register keys so diffs line up
// without translation. js8086 stores 16-bit regs as high/low halves —
// we combine them back to the uppercase names calcite uses.
function snapshotRegs(cpu) {
  const r = cpu.getRegs();
  return {
    AX: ((r.ah & 0xFF) << 8) | (r.al & 0xFF),
    BX: ((r.bh & 0xFF) << 8) | (r.bl & 0xFF),
    CX: ((r.ch & 0xFF) << 8) | (r.cl & 0xFF),
    DX: ((r.dh & 0xFF) << 8) | (r.dl & 0xFF),
    SI: r.si,
    DI: r.di,
    BP: r.bp,
    SP: r.sp,
    CS: r.cs,
    DS: r.ds,
    ES: r.es,
    SS: r.ss,
    IP: r.ip,
    FLAGS: r.flags,
  };
}

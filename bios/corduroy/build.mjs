#!/usr/bin/env node
/* build.mjs — orchestrate OpenWatcom build of bios.bin.

   Reads bios/toolchain.env, compiles .c/.asm → .obj, links → bios.bin.
   Regenerates logo_data.c from tests/logo.bin if newer. */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function loadEnv(path) {
    const env = {};
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const m = rawLine.match(/^([A-Z_]+)=(.+)$/);
        if (m) env[m[1]] = m[2].trim();
    }
    return env;
}

const env = loadEnv(join(__dirname, 'toolchain.env'));
const BUILD_DIR = join(__dirname, 'build');
mkdirSync(BUILD_DIR, { recursive: true });

function needsRebuild(src, dst) {
    if (!existsSync(dst)) return true;
    return statSync(src).mtimeMs > statSync(dst).mtimeMs;
}

function run(cmd, args, opts = {}) {
    console.log(`> ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

// 1. Regenerate logo_data.c if stale
const logoSrc = join(repoRoot, 'tests', 'logo.bin');
const logoC = join(__dirname, 'logo_data.c');
if (existsSync(logoSrc) && needsRebuild(logoSrc, logoC)) {
    run('python', [join(repoRoot, 'tools', 'bin-to-c.py'), logoSrc, logoC, 'logo_bin']);
}

// 2. Assemble .asm → .obj via NASM (OMF object format for wlink)
const asmSources = ['entry.asm', 'handlers.asm'];
for (const src of asmSources) {
    const obj = join(BUILD_DIR, src.replace('.asm', '.obj'));
    if (needsRebuild(join(__dirname, src), obj)) {
        run(env.NASM, ['-f', 'obj', '-o', obj, join(__dirname, src)]);
    }
}

// 3. Compile .c → .obj (list grows as tasks add files)
const cSources = ['bios_init.c', 'font.c', 'splash.c', 'logo_data.c'];
for (const src of cSources) {
    const obj = join(BUILD_DIR, src.replace('.c', '.obj'));
    if (needsRebuild(join(__dirname, src), obj)) {
        run(env.WCC, ['-ms', '-0', '-s', '-zl', `-fo=${obj}`, `-i=${env.WATCOM_INCLUDE}`, join(__dirname, src)]);
    }
}

// 4. Link
const lnkFile = join(__dirname, 'link.lnk');
run(env.WLINK, [`@${lnkFile}`], { cwd: BUILD_DIR });

// wlink outputs to cwd (build/) by default
const outBin = join(BUILD_DIR, 'bios.bin');
if (!existsSync(outBin)) {
    // Fallback: wlink may have written to repo root
    if (existsSync('bios.bin')) {
        writeFileSync(outBin, readFileSync('bios.bin'));
        unlinkSync('bios.bin');
    }
}

console.log(`bios.bin built: ${statSync(outBin).size} bytes`);

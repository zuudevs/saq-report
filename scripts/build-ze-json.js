'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoDirectory = path.resolve(__dirname, '..', 'vendor', 'ze_json');
const presetFile = path.join(repoDirectory, 'CMakePresets.json');
const wasmFile = path.join(
    repoDirectory,
    'build',
    'wasm64-release',
    'src',
    'ze_json_core.wasm'
);

if (!fs.existsSync(presetFile)) {
    console.error('Submodule ze_json tidak ditemukan.');
    console.error('Jalankan: git submodule update --init --recursive');
    process.exit(1);
}

function runCMake(args) {
    const result = spawnSync('cmake', args, {
        cwd: repoDirectory,
        stdio: 'inherit',
    });

    if (result.error) {
        console.error('Gagal menjalankan cmake:', result.error.message);
        process.exit(1);
    }

    if (result.status !== 0) {
        process.exit(result.status === null ? 1 : result.status);
    }
}

runCMake(['--preset', 'wasm64-release']);
runCMake(['--build', 'build/wasm64-release']);

if (!fs.existsSync(wasmFile)) {
    console.error('Build selesai tetapi file WASM tidak ditemukan:', wasmFile);
    process.exit(1);
}

console.log('ze_json WASM siap:', wasmFile);

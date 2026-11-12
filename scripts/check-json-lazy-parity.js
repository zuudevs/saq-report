'use strict';

/**
 * check-json-lazy-parity.js — gate parity jalur lazy read-only (ND-5).
 *
 * Mengunci bahwa jalur ze_json (readCount()) menghasilkan nilai YANG SAMA
 * dengan baseline `read().length` untuk setiap input: file data store,
 * cache Mongo (disimulasikan tanpa MongoDB), file hilang, dan edge
 * semantik (missing-key, null, string/number/boolean, urutan array tidak
 * relevan untuk count; duplicate-key sudah dikunci di level binding oleh
 * tests/lazy.mjs T2 — data store SAQ tidak menyandikan duplikat).
 *
 * Sumber data default: workspace corpus `corpus/benchmarks/saq_payload_v1/`
 * (salinan provenance-tracked store asli, manifest sha256 P0-8) karena file
 * runtime tidak ter-commit; path dapat dioverride via CLI arg (per-file).
 *
 * Jalankan: node scripts/check-json-lazy-parity.js
 * Exit code 0 = semua parity hijau.
 *
 * @cite 10.1002_spe.3313 on-demand JSON — semantik akses selektif harus
 *       identik dengan baseline materialisasi pada semua input.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const JsonRepository = require('../repositories/JsonRepository');
const MongoJsonRepository = require('../repositories/MongoJsonRepository');

const CORPUS = process.env.SAQ_JSON_PARITY_DIR
    || path.join(__dirname, '..', '..', 'corpus', 'benchmarks', 'saq_payload_v1');

let failures = 0;
let checked = 0;

function fail(label, detail) {
    failures += 1;
    console.error(`  FAIL ${label} — ${detail}`);
}

/**
 * Semantik `.length` aplikasi yang dipanggil route (baseline):
 * null/undefined -> TypeError; array/string -> .length; lainnya -> undefined.
 */
function routeLength(v) {
    if (v === null || v === undefined) {
        throw new TypeError(
            `Cannot read properties of ${v === null ? 'null' : 'undefined'} (reading 'length')`);
    }
    if (Array.isArray(v) || typeof v === 'string') {
        return v.length;
    }
    return undefined;
}

/** Baseline persis: repo.read() lalu .length di call-site. */
function baselineFileLength(file, rootKey, defaultValue) {
    let json;
    try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            return routeLength(defaultValue);
        }
        throw err;
    }
    const value = rootKey ? (json[rootKey] ?? defaultValue) : json;
    return routeLength(value);
}

/** Bandingkan dua nilai via Object.is + kesamaan "keduanya undefined". */
function assertParity(label, expected, actual) {
    checked += 1;
    const same = expected === actual
        || (expected === undefined && actual === undefined);
    if (same) {
        console.log(`  ok   ${label} (${actual === undefined ? 'undefined' : actual})`);
    } else {
        fail(label, `baseline=${expected}, ze=${actual}`);
    }
}

/** Bandingkan bahwa KEDUA sisi melempar error dengan jenis yang sama. */
function assertBothThrow(label, fnBaseline, fnZe, errorName) {
    checked += 1;
    let bErr = null;
    let zErr = null;
    try { fnBaseline(); } catch (err) { bErr = err; }
    try { fnZe(); } catch (err) { zErr = err; }
    if (bErr && zErr && bErr.constructor === zErr.constructor) {
        console.log(`  ok   ${label} (keduanya ${bErr.constructor.name})`);
    } else {
        fail(label, `baseline=${bErr && bErr.constructor.name}, `
            + `ze=${zErr && zErr.constructor.name}`);
    }
}

/** Definisi repo — mirror repositories/index.js. */
function repoDefs(dir) {
    return [
        { name: 'assistants',   file: path.join(dir, 'config_asisten.json'), rootKey: 'assistants', defaultValue: [] },
        { name: 'courses',      file: path.join(dir, 'courses.json'),        rootKey: 'courses',    defaultValue: [] },
        { name: 'lecturers',    file: path.join(dir, 'lecturers.json'),      rootKey: 'lecturers',  defaultValue: [] },
        { name: 'schedules',    file: path.join(dir, 'schedules.json'),      rootKey: 'schedules',  defaultValue: [] },
        { name: 'reports',      file: path.join(dir, 'reports.json'),        rootKey: null,         defaultValue: [] },
        { name: 'globalConfig', file: path.join(dir, 'config_global.json'),  rootKey: null,         defaultValue: {} },
    ];
}

// === 1. Parity file data store (JsonRepository.readCount vs read().length) ==
console.log('[parity] 1. file data store (corpus saq_payload_v1, provenance P0-8)');
for (const def of repoDefs(CORPUS)) {
    if (!fs.existsSync(def.file)) {
        fail(def.name, `file tidak ditemukan: ${def.file}`);
        continue;
    }
    const repo = new JsonRepository(def.file, def.rootKey, def.defaultValue);
    assertParity(
        `file:${def.name} (rootKey=${def.rootKey})`,
        baselineFileLength(def.file, def.rootKey, def.defaultValue),
        repo.readCount(),
    );
}

// === 2. Parity cache Mongo (simulasi tanpa MongoDB) ==========================
console.log('[parity] 2. cache Mongo (unwrapped, _cacheLoaded=true — tanpa MongoDB)');
for (const def of repoDefs(CORPUS)) {
    if (!fs.existsSync(def.file)) {
        fail(`mongo:${def.name}`, `file tidak ditemukan: ${def.file}`);
        continue;
    }
    const mr = new MongoJsonRepository(def.file, def.rootKey, def.defaultValue, `parity-${def.name}`);
    // Replikasi state pasca-init(): cache = seedRepo.read() (rootKey diterapkan).
    const parsed = JSON.parse(fs.readFileSync(def.file, 'utf8'));
    mr._cache = def.rootKey ? (parsed[def.rootKey] ?? def.defaultValue) : parsed;
    mr._cacheLoaded = true;
    assertParity(`mongo:${def.name}`, routeLength(mr.read()), mr.readCount());
}

// === 3. File hilang -> default ==============================================
console.log('[parity] 3. file hilang (ENOENT -> defaultValue)');
{
    const missing = path.join(os.tmpdir(), `saq-parity-${Date.now()}-absent.json`);
    const repo = new JsonRepository(missing, 'assistants', []);
    assertParity('missing-file -> default []',
        routeLength(repo.read()), repo.readCount());
    const repoObj = new JsonRepository(missing, null, {});
    assertParity('missing-file -> default {}',
        routeLength(repoObj.read()), repoObj.readCount());
}

// === 4. Edge semantik (dokumen buatan di tmp) ===============================
console.log('[parity] 4. edge semantik: missing-key / null / string / number / object');
const tmpDocs = path.join(os.tmpdir(), `saq-parity-${Date.now()}`);
fs.mkdirSync(tmpDocs, { recursive: true });

const writeDoc = (name, text) => {
    const file = path.join(tmpDocs, name);
    fs.writeFileSync(file, text, 'utf8');
    return file;
};

// `throws: true` = kedua sisi HARUS melempar error dengan jenis yang sama;
// tanpa flag = kedua sisi HARUS sukses dengan nilai yang sama (assertParity).
const edges = [
    { name: 'field-null.json',    text: '{"schedules":null}',        rootKey: 'schedules' },
    { name: 'field-string.json',  text: '{"schedules":"abc"}',       rootKey: 'schedules' },
    { name: 'field-number.json',  text: '{"schedules":42}',          rootKey: 'schedules' },
    { name: 'field-bool.json',    text: '{"schedules":true}',        rootKey: 'schedules' },
    { name: 'field-object.json',  text: '{"schedules":{"a":1}}',     rootKey: 'schedules' },
    { name: 'key-absen.json',     text: '{"other":[]}',              rootKey: 'schedules' },
    { name: 'nested-array.json',  text: '{"schedules":[{"a":1},{"b":2},{"c":3}]}', rootKey: 'schedules' },
    { name: 'root-array.json',    text: '[1,2,3,4,5]',               rootKey: null },
    { name: 'root-object.json',   text: '{"a":1}',                   rootKey: null },
    { name: 'root-string.json',   text: '"just a string"',           rootKey: null },
    { name: 'root-null.json',     text: 'null',                      rootKey: null,         throws: true },
    { name: 'root-null-key.json', text: 'null',                      rootKey: 'schedules',  throws: true },
];

for (const edge of edges) {
    const file = writeDoc(edge.name, edge.text);
    const repo = new JsonRepository(file, edge.rootKey, []);
    if (edge.throws) {
        assertBothThrow(
            `edge:${edge.name} (rootKey=${edge.rootKey})`,
            () => routeLength(repo.read()),
            () => repo.readCount(),
        );
    } else {
        assertParity(
            `edge:${edge.name} (rootKey=${edge.rootKey})`,
            routeLength(repo.read()),
            repo.readCount(),
        );
    }
}

// === Ringkasan ==============================================================
console.log(`[parity] ${checked} check(s): ${failures === 0
    ? 'semua parity hijau (baseline == ze)'
    : `${failures} kegagalan`}`);
process.exit(failures === 0 ? 0 : 1);

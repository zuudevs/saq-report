'use strict';

/**
 * zeJsonBinding — loader ze_json wasm64 untuk jalur baca lazy read-only
 * server SAQ (ND-5, desain workspace docs/architecture/lazy-access-api.md).
 *
 * Kontrak:
 *  - Baseline V8 TIDAK diubah: modul ini hanya dipakai call-site opt-in
 *    (SAQ_JSON_ENGINE=ze). Tanpa flag, jalur lama berjalan apa adanya.
 *  - Sole owner slot parser (scope ND-5): open -> count -> close ->
 *    resetHeap dilakukan SINKRON dalam satu fungsi (tanpa await di antara),
 *    sehingga atomik terhadap event loop — resetHeap tidak pernah
 *    mematikan slot parser hidup milik handler lain.
 *  - Node >= 24 (syarat binding wasm64 C-ABI). require(esm) dipakai untuk
 *    memuat ze_json.mjs secara sinkron (Node >= 22.12 unflagged, stabil
 *    di Node 24); binding ESM ini tanpa top-level await.
 *
 * @cite 10.1002_spe.3313 on-demand JSON — akses field/hitung count tanpa
 *       materialisasi seluruh dokumen.
 * @cite 10.14778_3115404.3115416 Mison — structural index yang menopang
 *       count tanpa parse penuh.
 */

const path = require('path');

const BINDING_PATH = process.env.ZE_JSON_BINDING_PATH
    || path.join(__dirname, '..', '..', 'ze_json', 'bindings', 'js', 'ze_json.mjs');

/** NODE_KINDS index (mirror bindings/js/ze_json.mjs). */
const KIND = {
    unknown: 0, object: 1, array: 2, string: 3,
    number: 4, true: 5, false: 6, null: 7,
};

let binding = null;   // instance ZeJson (dimuat sekali per proses)
let ZeParser = null;  // class ZeParser dari modul binding

function getBinding() {
    if (!binding) {
        const mod = require(BINDING_PATH);
        ZeParser = mod.ZeParser;
        binding = mod.ZeJson.load();
    }
    return binding;
}

/**
 * Parity helper `.length` aplikasi untuk nilai JSON mentah (default repo,
 * cache Mongo) — array/string -> .length; object/number/boolean -> undefined;
 * null/undefined -> throw TypeError (baseline: caller `.length` pada nilai
 * tersebut melempar persis seperti ini).
 * @param {*} v nilai JSON
 * @returns {number|undefined}
 */
function valueLength(v) {
    if (v === null || v === undefined) {
        throw new TypeError(
            `Cannot read properties of ${v === null ? 'null' : 'undefined'} `
            + `(reading 'length')`);
    }
    if (Array.isArray(v) || typeof v === 'string') {
        return v.length;
    }
    return undefined; // object / number / boolean
}

/**
 * Hitung nilai yang akan dihasilkan `.length` aplikasi pada data repo —
 * PARITY penuh dengan semantik baseline `read().length`:
 *   array   -> jumlah elemen (structural count, tanpa parse child)
 *   string  -> panjang terdecode (V8-locked)
 *   object/number/boolean -> undefined ({}.length)
 *   jalur rootKey:
 *     root null          -> throw TypeError (DI DALAM read() baseline ->
 *                           dibungkus AppError oleh JsonRepository.readCount)
 *     root bukan object  -> `x[key]` undefined -> `?? default` -> default
 *     key absen          -> `undefined ?? default` -> default
 *     nilai null         -> `null ?? default` -> default (?? trigger pada null)
 *   jalur root tanpa rootKey:
 *     root null          -> throw TypeError di CALL-SITE (`null.length`,
 *                           di luar read()) — diteruskan apa adanya
 *
 * @param {Buffer|Uint8Array} bytes JSON mentah
 * @param {string|null} rootKey key pembungkus file (null = root langsung)
 * @param {*} defaultValue nilai default repo (untuk replikasi `?? default`)
 * @returns {number|undefined} nilai `.length` yang identik dengan baseline
 * @throws {ZeParserError|TypeError} JSON invalid / akses null seperti baseline
 */
function countJsonBytes(bytes, rootKey, defaultValue) {
    const b = getBinding();
    const parser = ZeParser.open(b, bytes);
    try {
        let ts = parser.rootTs;
        let cursor = 0;

        if (rootKey !== null && rootKey !== undefined) {
            const rootKind = parser.kind(ts);
            if (rootKind === KIND['null']) {
                // Parity baseline: `json[rootKey]` pada json null -> TypeError
                // DI DALAM read() (try/catch) -> AppError oleh readCount.
                throw new TypeError(
                    `Cannot read properties of null (reading '${rootKey}')`);
            }
            if (rootKind !== KIND.object) {
                // Parity baseline: "abc"[key] / (5)[key] / [..][key]
                // -> undefined -> `?? default` -> `.length` default.
                return valueLength(defaultValue);
            }
            const field = parser.get(rootKey, ts, cursor);
            if (field === undefined) {
                // Parity baseline: key absen -> `undefined ?? default`.
                return valueLength(defaultValue);
            }
            ts = field.ts;
            cursor = field.cursor;
            const fieldKind = parser.kind(ts);
            if (fieldKind === KIND['null']) {
                // Parity baseline: `null ?? default` — nullish coalescing
                // trigger pada null, bukan hanya undefined.
                return valueLength(defaultValue);
            }
            if (fieldKind === KIND.array) {
                return parser.countElements(ts);
            }
            if (fieldKind === KIND.string) {
                return parser.getString(ts).length;
            }
            return undefined; // object/number/boolean: `.length` == undefined
        }

        // Jalur root langsung (rootKey null): `.length` pada root.
        const kind = parser.kind(ts);
        if (kind === KIND['null']) {
            // Parity baseline: TypeError di CALL-SITE (`null.length`, di luar
            // read()) — diteruskan apa adanya (JANGAN dibungkus AppError).
            throw new TypeError(
                "Cannot read properties of null (reading 'length')");
        }
        if (kind === KIND.array) {
            return parser.countElements(ts);
        }
        if (kind === KIND.string) {
            return parser.getString(ts).length;
        }
        return undefined; // object/number/boolean: `.length` == undefined
    } finally {
        parser.close();
        b.resetHeap(); // sole-owner + sinkron: aman (kontrak header)
    }
}

module.exports = { getBinding, countJsonBytes, valueLength, BINDING_PATH };

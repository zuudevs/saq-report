'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const enabled = process.env.JSON_PARSER_BENCHMARK === '1';
const PAYLOAD_LIMIT = process.env.JSON_BODY_LIMIT || '100kb';
const MAX_ZE_JSON_PAYLOAD_BYTES = 1024 * 1024;

const rawJsonParser = express.raw({
    type: 'application/json',
    limit: PAYLOAD_LIMIT,
});

let zeJson = null;
let outputStream = null;
let outputFile = null;
let sequence = 0;

function getRootKind(jsonText) {
    const first = jsonText.search(/\S/);
    if (first === -1) return 'empty';

    switch (jsonText[first]) {
        case '{': return 'object';
        case '[': return 'array';
        case '"': return 'string';
        case 't':
        case 'f': return 'boolean';
        case 'n': return 'null';
        default: return 'number-or-invalid';
    }
}

async function initialize() {
    if (!enabled) return;

    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor < 24) {
        throw new Error(
            'Benchmark ze_json memerlukan Node.js >= 24 karena binding WASM memakai memory64.'
        );
    }

    // Paket npm menyertakan ze_json.mjs dan ze_json_core.wasm, sehingga
    // pengguna tidak perlu checkout submodule atau membangun WASM sendiri.
    const { ZeJson } = await import('@zuudevs/ze-json');
    zeJson = await ZeJson.load();

    // Warm-up di luar pengukuran request agar biaya startup tidak bercampur
    // dengan angka payload pertama.
    const warmupPayload = '{"benchmarkWarmup":true}';
    for (let i = 0; i < 50; i += 1) {
        zeJson.openDocument(warmupPayload);
        JSON.parse(warmupPayload);
    }

    const configuredDirectory = process.env.JSON_PARSER_BENCHMARK_DIR;
    const outputDirectory = configuredDirectory
        ? path.resolve(configuredDirectory)
        : path.join(ROOT, 'output', 'benchmarks', 'json-parser');

    fs.mkdirSync(outputDirectory, { recursive: true });

    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    outputFile = path.join(
        outputDirectory,
        'json-parser-' + runId + '-' + process.pid + '.jsonl'
    );

    outputStream = fs.createWriteStream(outputFile, { flags: 'wx' });
    outputStream.on('error', (error) => {
        console.error('[JSON benchmark] Gagal menulis hasil:', error.message);
    });
    await once(outputStream, 'open');

    console.log('[JSON benchmark] Aktif; hasil disimpan ke ' + outputFile);
}

function writeResult(result) {
    if (!outputStream || outputStream.destroyed) return;
    outputStream.write(JSON.stringify(result) + '\n');
}

function makeResult(req, rawBody, rootKind, zeMeasurement, jsonMeasurement) {
    // writeText menyisihkan satu byte NUL di belakang payload, jadi payload
    // harus lebih kecil dari kapasitas region 1 MiB, bukan sama dengannya.
    const zeJsonSupportedForComparison =
        rootKind === 'object' && rawBody.length < MAX_ZE_JSON_PAYLOAD_BYTES;
    const comparable =
        zeJsonSupportedForComparison &&
        zeMeasurement.ok === true &&
        jsonMeasurement.ok === true;

    return {
        schema_version: 1,
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        method: req.method,
        route: req.path,
        payload_bytes: rawBody.length,
        payload_sha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
        root_kind: rootKind,
        express_json_strict_accepted: rootKind === 'object' || rootKind === 'array',
        ze_json: {
            attempted: true,
            elapsed_ns: zeMeasurement.elapsedNs,
            ok: zeMeasurement.ok,
            error_name: zeMeasurement.errorName,
            supported_root_and_size: zeJsonSupportedForComparison,
        },
        json_parse: {
            elapsed_ns: jsonMeasurement.elapsedNs,
            ok: jsonMeasurement.ok,
            error_name: jsonMeasurement.errorName,
        },
        comparable,
        ze_json_speedup_ratio: comparable
            ? jsonMeasurement.elapsedNs / Math.max(zeMeasurement.elapsedNs, 1)
            : null,
        comparison_scope:
            'ze_json: scanner + tape/Session setup (on-demand); JSON.parse: full JavaScript value materialization. Workloads differ.',
    };
}

function middleware(req, res, next) {
    rawJsonParser(req, res, (rawError) => {
        if (rawError) return next(rawError);
        if (!Buffer.isBuffer(req.body)) return next();

        const rawBody = req.body;
        if (rawBody.length === 0) {
            // Menjaga semantik express.json untuk body JSON kosong.
            req.body = {};
            return next();
        }

        let jsonText = rawBody.toString('utf8');
        // body-parser JSON membuang UTF-8 BOM sebelum memanggil JSON.parse.
        if (jsonText.charCodeAt(0) === 0xFEFF) {
            jsonText = jsonText.slice(1);
        }

        const rootKind = getRootKind(jsonText);

        const zeStart = process.hrtime.bigint();
        let zeOk = false;
        let zeErrorName = null;
        try {
            // openDocument melakukan scan/validasi dan membangun tape + Session.
            // Hasil Doc tidak dipakai agar biaya baca nilai tidak ikut diukur.
            zeJson.openDocument(jsonText);
            zeOk = true;
        } catch (error) {
            zeErrorName = error && error.name ? error.name : 'Error';
        }
        const zeElapsedNs = Number(process.hrtime.bigint() - zeStart);

        const jsonStart = process.hrtime.bigint();
        let parsedValue;
        try {
            parsedValue = JSON.parse(jsonText);
        } catch (error) {
            const jsonElapsedNs = Number(process.hrtime.bigint() - jsonStart);

            writeResult(makeResult(
                req,
                rawBody,
                rootKind,
                { elapsedNs: zeElapsedNs, ok: zeOk, errorName: zeErrorName },
                {
                    elapsedNs: jsonElapsedNs,
                    ok: false,
                    errorName: error && error.name ? error.name : 'Error',
                }
            ));

            // Meniru error JSON dari body-parser: request malformed tetap 400.
            error.status = 400;
            error.type = 'entity.parse.failed';
            return next(error);
        }

        const jsonElapsedNs = Number(process.hrtime.bigint() - jsonStart);
        writeResult(makeResult(
            req,
            rawBody,
            rootKind,
            { elapsedNs: zeElapsedNs, ok: zeOk, errorName: zeErrorName },
            { elapsedNs: jsonElapsedNs, ok: true, errorName: null }
        ));

        // express.json strict mode menerima object/array, bukan JSON scalar.
        if (rootKind !== 'object' && rootKind !== 'array') {
            const strictError = new SyntaxError(
                'JSON body root must be an object or array.'
            );
            strictError.status = 400;
            strictError.type = 'entity.parse.failed';
            return next(strictError);
        }

        req.body = parsedValue;
        return next();
    });
}

async function close() {
    if (zeJson) {
        try {
            zeJson.close();
        } catch (error) {
            console.error('[JSON benchmark] Gagal merilis arena ze_json:', error.message);
        }
        zeJson = null;
    }

    if (!outputStream || outputStream.destroyed) return;
    const stream = outputStream;
    outputStream = null;
    await new Promise((resolve) => stream.end(resolve));
}

module.exports = {
    enabled,
    initialize,
    middleware,
    close,
    get outputFile() {
        return outputFile;
    },
};

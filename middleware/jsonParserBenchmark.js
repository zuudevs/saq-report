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

    // Paket npm menyertakan binding JavaScript dan file WASM yang sudah dibangun.
    const { ZeJson } = await import('@zuudevs/ze-json');
    zeJson = await ZeJson.load();

    // Warm-up startup dilakukan sebelum file hasil dibuat.
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

function makeResult(req, rawBody, rootKind, zeMeasurement, jsonMeasurement, executionOrder) {
    // writeText menyisihkan satu byte NUL di belakang payload, jadi payload
    // harus lebih kecil dari kapasitas region 1 MiB, bukan sama dengannya.
    const zeJsonSupportedForComparison =
        rootKind === 'object' && rawBody.length < MAX_ZE_JSON_PAYLOAD_BYTES;
    const comparable =
        zeJsonSupportedForComparison &&
        zeMeasurement.ok === true &&
        jsonMeasurement.ok === true;
    const requestedWorkload = req.get('x-benchmark-workload');

    return {
        schema_version: 2,
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        benchmark_phase: req.get('x-benchmark-phase') === 'warmup'
            ? 'warmup'
            : 'measurement',
        workload: typeof requestedWorkload === 'string'
            ? requestedWorkload.slice(0, 80)
            : null,
        execution_order: executionOrder,
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
            error_message: zeMeasurement.errorMessage,
            supported_root_and_size: zeJsonSupportedForComparison,
        },
        json_parse: {
            elapsed_ns: jsonMeasurement.elapsedNs,
            ok: jsonMeasurement.ok,
            error_name: jsonMeasurement.errorName,
            error_message: jsonMeasurement.errorMessage || null,
        },
        comparable,
        ze_json_speedup_ratio: comparable
            ? jsonMeasurement.elapsedNs / Math.max(zeMeasurement.elapsedNs, 1)
            : null,
        comparison_scope:
            'ze_json: scanner + tape/Session setup (on-demand); JSON.parse: full JavaScript value materialization. Workloads differ.',
    };
}

function measureZeJson(jsonText) {
    const start = process.hrtime.bigint();
    let ok = false;
    let errorName = null;
    let errorMessage = null;

    try {
        // Hanya scan/validasi dan persiapan tape + Session yang diukur.
        zeJson.openDocument(jsonText);
        ok = true;
    } catch (error) {
        errorName = error && error.name ? error.name : 'Error';
        errorMessage = error && error.message ? error.message : String(error);
    }

    return {
        elapsedNs: Number(process.hrtime.bigint() - start),
        ok,
        errorName,
        errorMessage,
    };
}

function timeJsonParse(jsonText) {
    const start = process.hrtime.bigint();

    try {
        const value = JSON.parse(jsonText);
        return {
            elapsedNs: Number(process.hrtime.bigint() - start),
            ok: true,
            errorName: null,
            errorMessage: null,
            error: null,
            value,
        };
    } catch (error) {
        return {
            elapsedNs: Number(process.hrtime.bigint() - start),
            ok: false,
            errorName: error && error.name ? error.name : 'Error',
            errorMessage: error && error.message ? error.message : String(error),
            error,
            value: undefined,
        };
    }
}

function middleware(req, res, next) {
    rawJsonParser(req, res, (rawError) => {
        if (rawError) return next(rawError);
        if (!Buffer.isBuffer(req.body)) return next();

        const rawBody = req.body;
        if (rawBody.length === 0) {
            req.body = {};
            return next();
        }

        let jsonText = rawBody.toString('utf8');
        // body-parser JSON membuang UTF-8 BOM sebelum memanggil JSON.parse.
        if (jsonText.charCodeAt(0) === 0xFEFF) {
            jsonText = jsonText.slice(1);
        }

        const rootKind = getRootKind(jsonText);
        // Ganti urutan parser secara bergantian untuk mengurangi bias urutan
        // eksekusi. Urutan aktual dicatat agar dapat dianalisis belakangan.
        const nextSequence = sequence + 1;
        const executionOrder = nextSequence % 2 === 0
            ? 'ze_json-first'
            : 'json_parse-first';

        let zeMeasurement;
        let jsonMeasurement;
        if (executionOrder === 'ze_json-first') {
            zeMeasurement = measureZeJson(jsonText);
            jsonMeasurement = timeJsonParse(jsonText);
        } else {
            jsonMeasurement = timeJsonParse(jsonText);
            zeMeasurement = measureZeJson(jsonText);
        }

        if (!jsonMeasurement.ok) {
            writeResult(makeResult(
                req,
                rawBody,
                rootKind,
                zeMeasurement,
                jsonMeasurement,
                executionOrder
            ));

            // Meniru error JSON dari body-parser: request malformed tetap 400.
            jsonMeasurement.error.status = 400;
            jsonMeasurement.error.type = 'entity.parse.failed';
            return next(jsonMeasurement.error);
        }

        writeResult(makeResult(
            req,
            rawBody,
            rootKind,
            zeMeasurement,
            jsonMeasurement,
            executionOrder
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

        req.body = jsonMeasurement.value;
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

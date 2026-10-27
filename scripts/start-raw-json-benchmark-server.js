'use strict';

/**
 * Server HTTP benchmark live parser JSON berbasis Benchmark.js.
 *
 * Alur per request POST /benchmark (body = raw JSON payload):
 *   1. Payload divalidasi di luar jalur terukur: satu panggilan JSON.parse,
 *      satu panggilan ze.openDocument, plus pemeriksaan ukuran dan root.
 *   2. Dibuat instance Benchmark.Suite dengan dua test case:
 *      JSON.parse(payload) dan ze_json(payload) — sisi ze_json diwakili
 *      ze.openDocument(payload): encodeInto + reset arena + scanner + tape
 *      + persiapan Session (metodologi sama dengan runner offline).
 *   3. Suite dijalankan asinkron. Antrian internal memastikan hanya satu
 *      suite berjalan pada satu waktu sehingga siklus pengukuran tidak
 *      saling mengganggu (sekaligus menghilangkan race pada payload).
 *   4. Pada event 'cycle' per test, array waktu eksekusi mentah
 *      (event.target.stats.sample, satuan detik per operasi) diekstrak.
 *      Pada event 'complete', record dirakit TANPA kalkulasi perbandingan
 *      dan TANPA penentuan pemenang.
 *   5. Record ditambahkan ke file data (format JSON Lines: satu objek JSON
 *      per baris) melalui antrian tulis terserialisasi (fs.promises.appendFile),
 *      lalu klien menerima 200 {"status":"saved"} tanpa data benchmark.
 *
 * File data default: output/benchmarks/json-parser/raw_benchmark_data.json
 * Format baris (NDJSON) dipilih agar operasi append aman terhadap request
 * berdekatan dan crash mid-write paling banyak membuang satu baris terakhir.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const Benchmark = require('benchmark');

const ROOT = path.resolve(__dirname, '..');

// Region payload wasm ze_json adalah 1 MiB dan writeText menambahkan satu
// byte NUL di belakang payload, jadi payload harus benar-benar lebih kecil.
const MAX_ZE_JSON_PAYLOAD_BYTES = 1024 * 1024;
const TEST_JSON_PARSE = 'JSON.parse';
const TEST_ZE_JSON = 'ze_json';

function readOptions(argv) {
    const options = {
        port: Number(process.env.BENCHMARK_PORT) || 3100,
        host: process.env.BENCHMARK_HOST || '127.0.0.1',
        maxTime: 5,
        minSamples: 10,
        warmup: 20,
        bodyLimit: process.env.JSON_BODY_LIMIT || '1mb',
        maxQueue: 64,
        scanner: 'auto',
        dataFile: process.env.RAW_BENCHMARK_DATA_FILE || null,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        const eq = arg.indexOf('=');
        const key = eq < 0 ? arg : arg.slice(0, eq);
        const inline = eq < 0 ? undefined : arg.slice(eq + 1);
        const value = inline === undefined ? argv[++i] : inline;

        if (key === '--port') options.port = Number(value);
        else if (key === '--host') options.host = value;
        else if (key === '--max-time') options.maxTime = Number(value);
        else if (key === '--min-samples') options.minSamples = Number(value);
        else if (key === '--warmup') options.warmup = Number(value);
        else if (key === '--max-queue') options.maxQueue = Number(value);
        else if (key === '--scanner') options.scanner = String(value);
        else if (key === '--data-file') options.dataFile = value;
        else if (key === '--body-limit') options.bodyLimit = value;
        else throw new Error('Opsi tidak dikenal: ' + key + '. Gunakan --help.');
    }

    if (options.help) return options;

    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Error('--port harus bilangan bulat 1..65535.');
    }
    if (!Number.isFinite(options.maxTime) || options.maxTime < 0.5) {
        throw new Error('--max-time harus angka >= 0.5 detik.');
    }
    if (!Number.isInteger(options.minSamples) || options.minSamples < 5) {
        throw new Error('--min-samples harus bilangan bulat >= 5.');
    }
    if (!Number.isInteger(options.warmup) || options.warmup < 0) {
        throw new Error('--warmup harus bilangan bulat >= 0.');
    }
    if (!Number.isInteger(options.maxQueue) || options.maxQueue < 1) {
        throw new Error('--max-queue harus bilangan bulat >= 1.');
    }
    if (!['auto', 'scalar', 'wide'].includes(options.scanner)) {
        throw new Error('--scanner harus salah satu dari: auto, scalar, wide.');
    }
    if (typeof options.host !== 'string' || options.host.length === 0) {
        throw new Error('--host tidak boleh kosong.');
    }

    if (!options.dataFile) {
        const directory = process.env.JSON_PARSER_BENCHMARK_DIR
            ? path.resolve(process.env.JSON_PARSER_BENCHMARK_DIR)
            : path.join(ROOT, 'output', 'benchmarks', 'json-parser');
        options.dataFile = path.join(directory, 'raw_benchmark_data.json');
    } else {
        options.dataFile = path.resolve(options.dataFile);
    }

    return options;
}

function printHelp() {
    console.log(`Pemakaian:
  npm run start:raw-benchmark -- [opsi]

Server benchmark live: setiap POST /benchmark menjalankan satu Benchmark.Suite
(JSON.parse vs ze_json) atas payload yang dikirim, lalu menambahkan sampel
mentah ke file data JSON Lines. Respons klien hanya {"status":"saved"}.

Opsi:
  --port N          Port HTTP (default: BENCHMARK_PORT atau 3100)
  --host H          Alamat bind (default: BENCHMARK_HOST atau 127.0.0.1)
  --max-time SEC    Batas waktu Benchmark.js per test, detik (default 5)
  --min-samples N   Jumlah sampel siklus minimum per test (default 10)
  --warmup N        Panggilan warm-up eksplisit per parser sebelum suite (default 20)
  --max-queue N     Batas job menunggu di antrian; selebihnya ditolak 503 (default 64)
  --data-file PATH  File data JSON Lines (default: RAW_BENCHMARK_DATA_FILE atau
                    output/benchmarks/json-parser/raw_benchmark_data.json)
  --body-limit B    Batas body untuk body-parser, mis. '1mb' (default JSON_BODY_LIMIT atau '1mb')
  --scanner V       Varian scanner ze_json: auto | scalar | wide (default auto, ze_json >= 0.1.6)
  --help, -h        Tampilkan bantuan ini

Batas payload: root JSON harus object (kontrak Session ze_json) dan ukuran
UTF-8 harus < 1 MiB (region payload binding wasm). Satu suite berjalan pada
satu waktu; request berdekatan otomatis diantrekan dan tetap aman dari race.`);
}

// Versi dibaca langsung dari node_modules karena @zuudevs/ze-json tidak
// mengekspor subpath ./package.json lewat field "exports".
function dependencyVersion(moduleId) {
    const packagePath = path.join(
        ROOT, 'node_modules', ...moduleId.split('/'), 'package.json'
    );
    try {
        return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version || null;
    } catch {
        return null;
    }
}

let config;
try {
    config = readOptions(process.argv.slice(2));
} catch (error) {
    console.error('[Raw benchmark] Gagal:', error.message);
    process.exit(2);
}
if (config.help) {
    printHelp();
    process.exit(0);
}

const versions = {
    zeJson: dependencyVersion('@zuudevs/ze-json'),
    benchmarkJs: dependencyVersion('benchmark'),
};

let zeJson = null;
let server = null;
let shuttingDown = false;
let sequence = 0;
let queueDepth = 0;

// Antrian eksekusi suite: janji berantai memastikan task berikutnya baru
// berjalan setelah task sebelumnya selesai (sukses maupun gagal). Rejeksi
// diteruskan ke pemanggil task terkait saja, bukan ke request lain.
let runTail = Promise.resolve();

function enqueueRun(task) {
    const run = runTail.then(() => task());
    runTail = run.then(() => {}, () => {});
    return run;
}

// Antrian penulisan file: setiap fs.promises.appendFile menunggu tulisan
// sebelumnya tuntas sehingga baris JSON Lines tidak pernah tercampur saat
// banyak request diterima berdekatan.
let writeTail = Promise.resolve();

function appendRecordLine(line) {
    const write = writeTail.then(() =>
        fs.promises.appendFile(config.dataFile, line + '\n', 'utf8')
    );
    writeTail = write.then(() => {}, () => {});
    return write;
}

// Ekstraksi data mentah per test dari benchmark.js. Array stats.sample adalah
// waktu per operasi pada tiap siklus terukur (detik/op) dan tidak difilter.
function extractRawResult(bench) {
    const sample = Array.isArray(bench.stats && bench.stats.sample)
        ? bench.stats.sample.slice()
        : [];

    return {
        name: bench.name,
        status: bench.error ? 'error' : 'ok',
        error_message: bench.error ? String(bench.error) : null,
        aborted: bench.aborted === true,
        count: Number.isFinite(bench.count) ? bench.count : null,
        cycles: Number.isFinite(bench.cycles) ? bench.cycles : null,
        sample_unit: 'seconds_per_op',
        sample: sample,
    };
}

function buildRecord(job, results) {
    return {
        schema_version: 1,
        benchmark_engine: 'benchmark.js',
        sequence: job.sequence,
        timestamp: new Date().toISOString(),
        benchmark_phase: job.benchmarkPhase,
        workload: job.workload,
        execution_order: job.jsonParseFirst ? 'json_parse-first' : 'ze_json-first',
        payload_bytes: job.payloadBytes,
        payload_chars: job.payloadChars,
        payload_sha256: job.payloadSha256,
        configuration: {
            max_time_seconds: config.maxTime,
            min_samples: config.minSamples,
            warmup_calls_per_parser: config.warmup,
            scanner_variant: config.scanner,
        },
        runtime: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
            cpu_model: os.cpus()[0] ? os.cpus()[0].model : null,
        },
        libraries: {
            ze_json: versions.zeJson,
            benchmark_js: versions.benchmarkJs,
        },
        methodology: {
            json_parse: 'JSON.parse(payloadText): parsing penuh + materialisasi nilai JavaScript',
            ze_json: 'ze.openDocument(payloadText): encodeInto + reset arena + scanner/tape + persiapan Session',
            sample: 'results[].sample = array mentah stats.sample Benchmark.js (detik per operasi per siklus); server tidak melakukan kalkulasi perbandingan maupun penentuan pemenang',
        },
        results: results,
    };
}

// Menjalankan satu suite untuk satu job dan mengembalikan record siap simpan.
// resolve dipanggil pada event 'complete' suite; benchmark.js selalu memicu
// 'complete' untuk suite, termasuk ketika test di dalamnya error/abort.
function runSuiteJob(job) {
    return new Promise((resolve, reject) => {
        const payloadText = job.payloadText;
        let sinkValue = null;
        let sinkDoc = null;

        // Warm-up eksplisit di luar pengukuran, urutan bergantian agar
        // jalur JIT/wasm kedua parser terlanjur panas sebelum siklus terukur.
        for (let i = 0; i < config.warmup; i += 1) {
            if ((i + job.sequence) % 2 === 0) {
                sinkValue = JSON.parse(payloadText);
                sinkDoc = zeJson.openDocument(payloadText);
            } else {
                sinkDoc = zeJson.openDocument(payloadText);
                sinkValue = JSON.parse(payloadText);
            }
        }

        const suite = new Benchmark.Suite('SAQ raw JSON parser benchmark');
        const collected = new Map();

        const addTest = (name, fn) => {
            suite.add(name, {
                fn: fn,
                maxTime: config.maxTime,
                minSamples: config.minSamples,
                onError: (event) => {
                    console.error('[Raw benchmark] #' + job.sequence + ' test ' + name +
                        ' error: ' + String(event.target && event.target.error));
                },
            });
        };

        // Urutan penambahan bergantian per request untuk mengurangi bias
        // urutan eksekusi; urutan aktual dicatat di record.
        const jsonParseFn = function () { sinkValue = JSON.parse(payloadText); };
        const zeJsonFn = function () { sinkDoc = zeJson.openDocument(payloadText); };
        if (job.jsonParseFirst) {
            addTest(TEST_JSON_PARSE, jsonParseFn);
            addTest(TEST_ZE_JSON, zeJsonFn);
        } else {
            addTest(TEST_ZE_JSON, zeJsonFn);
            addTest(TEST_JSON_PARSE, jsonParseFn);
        }

        suite
            .on('cycle', (event) => {
                const bench = event.target;
                const result = extractRawResult(bench);
                collected.set(bench.name, result);
                console.log('[Raw benchmark] #' + job.sequence + ' test selesai: ' +
                    bench.name + ' status=' + result.status +
                    ' cycles=' + result.cycles + ' sample=' + result.sample.length);
            })
            .on('error', (event) => {
                console.error('[Raw benchmark] #' + job.sequence + ' suite error: ' +
                    String(event.target && event.target.error));
            })
            .on('complete', () => {
                // Susun hasil sesuai urutan penambahan test agar record
                // konsisten meskipun Map diisi saat event 'cycle'.
                const results = [TEST_JSON_PARSE, TEST_ZE_JSON]
                    .map((name) => collected.get(name))
                    .filter((result) => result);

                if (results.length !== 2) {
                    reject(new Error(
                        'Suite selesai tanpa hasil lengkap (diterima ' + results.length + ' test).'
                    ));
                    return;
                }

                // Rangkai record mentah; tidak ada kalkulasi perbandingan di sini.
                resolve(buildRecord(job, results));
            });

        suite.run({ async: true });
    });
}

const app = express();

app.get('/health', (_req, res) => {
    res.status(200).json({
        ok: true,
        service: 'saq-report-raw-json-benchmark',
        data_file: config.dataFile,
        queue_depth: queueDepth,
    });
});

app.post(
    '/benchmark',
    express.raw({ type: 'application/json', limit: config.bodyLimit }),
    (req, res) => {
        if (!Buffer.isBuffer(req.body)) {
            return res.status(415).json({
                status: 'error',
                error: 'Content-Type harus application/json.',
            });
        }
        if (req.body.length === 0) {
            return res.status(400).json({
                status: 'error',
                error: 'Body kosong. Kirim raw JSON payload pada body request.',
            });
        }

        // body-parser JSON membuang UTF-8 BOM sebelum parsing; lakukan sama
        // agar payload terukur identik dengan yang diproses aplikasi.
        let payloadText = req.body.toString('utf8');
        if (payloadText.charCodeAt(0) === 0xFEFF) {
            payloadText = payloadText.slice(1);
        }
        if (payloadText.trim().length === 0) {
            return res.status(400).json({
                status: 'error',
                error: 'Body kosong. Kirim raw JSON payload pada body request.',
            });
        }

        const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
        if (payloadBytes >= MAX_ZE_JSON_PAYLOAD_BYTES) {
            return res.status(413).json({
                status: 'error',
                error: 'Payload ' + payloadBytes + ' byte melebihi kapasitas region ze_json ' +
                    '(harus < ' + MAX_ZE_JSON_PAYLOAD_BYTES + ' byte).',
            });
        }

        // Validasi di luar jalur terukur: satu JSON.parse memastikan payload
        // valid dan bermakna untuk kedua test case.
        let parsed;
        try {
            parsed = JSON.parse(payloadText);
        } catch (error) {
            return res.status(400).json({
                status: 'error',
                error: 'Body bukan JSON valid: ' + error.message,
            });
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return res.status(400).json({
                status: 'error',
                error: 'Root payload harus JSON object. ze_json (kontrak Session) ' +
                    'tidak mendukung root array/scalar, sehingga kedua test tidak dapat dibandingkan.',
            });
        }

        // Preflight satu panggilan ze.openDocument: payload yang ditolak
        // scanner (mis. tape overflow) digagalkan cepat sebelum suite berjalan
        // agar setiap record tersimpan berisi sampel kedua parser.
        try {
            zeJson.openDocument(payloadText);
        } catch (error) {
            return res.status(400).json({
                status: 'error',
                error: 'Payload ditolak ze_json: ' + error.message,
            });
        }

        if (queueDepth >= config.maxQueue) {
            return res.status(503).json({
                status: 'error',
                error: 'Antrian benchmark penuh (' + queueDepth + ' job). Coba lagi nanti.',
            });
        }

        const jobSequence = ++sequence;
        const requestedWorkload = req.get('x-benchmark-workload');
        const job = {
            sequence: jobSequence,
            benchmarkPhase: req.get('x-benchmark-phase') === 'warmup' ? 'warmup' : 'measurement',
            workload: typeof requestedWorkload === 'string' && requestedWorkload
                ? requestedWorkload.slice(0, 80)
                : null,
            jsonParseFirst: jobSequence % 2 === 1,
            payloadText: payloadText,
            payloadBytes: payloadBytes,
            payloadChars: payloadText.length,
            payloadSha256: crypto.createHash('sha256').update(payloadText, 'utf8').digest('hex'),
        };

        queueDepth += 1;
        console.log('[Raw benchmark] #' + job.sequence + ' masuk antrian: workload=' +
            (job.workload || '-') + ' ' + job.payloadBytes + ' byte ' +
            'urutan=' + (job.jsonParseFirst ? 'json_parse-first' : 'ze_json-first') +
            ' (antrian=' + queueDepth + ')');

        enqueueRun(() => runSuiteJob(job))
            .then((record) => appendRecordLine(JSON.stringify(record)))
            .then(() => {
                console.log('[Raw benchmark] #' + job.sequence + ' tersimpan ke ' + config.dataFile);
                res.status(200).json({ status: 'saved' });
            })
            .catch((error) => {
                console.error('[Raw benchmark] #' + job.sequence + ' gagal: ' + error.message);
                if (!res.headersSent) {
                    res.status(500).json({
                        status: 'error',
                        error: 'Gagal menjalankan/menyimpan benchmark: ' + error.message,
                    });
                } else {
                    res.destroy();
                }
            })
            .finally(() => {
                queueDepth -= 1;
            });
    }
);

app.use((_req, res) => {
    res.status(404).json({
        status: 'error',
        error: 'Endpoint tidak ditemukan. Gunakan POST /benchmark atau GET /health.',
    });
});

// Pemetaan error body-parser dan error tak terduga ke respons JSON.
app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    let message = error.message || 'Terjadi kesalahan pada server benchmark.';
    if (error.type === 'entity.too.large') {
        message = 'Body melebihi batas ' + config.bodyLimit + ' (batas payload ze_json < 1 MiB).';
    }

    if (!res.headersSent) {
        res.status(status).json({ status: 'error', error: message });
    } else {
        res.destroy();
    }
});

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[Raw benchmark] Menerima ' + signal + ', menutup server...');

    const closeServer = new Promise((resolve) => {
        if (!server) return resolve();
        if (typeof server.closeIdleConnections === 'function') {
            server.closeIdleConnections();
        }
        server.close(resolve);
    });
    await closeServer;

    // Tunggu seluruh suite dan tulisan data tersisa selesai agar tidak ada
    // record setengah jalan saat proses keluar.
    await runTail;
    await writeTail;

    if (zeJson) {
        try {
            zeJson.close();
        } catch (error) {
            console.error('[Raw benchmark] Gagal merilis arena ze_json: ' + error.message);
        }
        zeJson = null;
    }

    process.exit(0);
}

async function start() {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor < 24) {
        throw new Error('Memerlukan Node.js >= 24 karena binding WASM ze_json memakai memory64.');
    }

    const { ZeJson } = await import('@zuudevs/ze-json');
    zeJson = await ZeJson.load({ scanner: config.scanner });

    // ZeJson.hasScannerSelection tersedia mulai binding v0.1.5; tolak cepat
    // bila varian non-auto diminta tetapi wasm terpasang tidak mendukungnya,
    // agar tidak ada pengukuran diam-diam memakai scanner yang keliru.
    if (config.scanner !== 'auto' && !zeJson.hasScannerSelection) {
        throw new Error(
            'Binding ze_json terpasang tidak mendukung pemilihan varian scanner. ' +
            'Gunakan --scanner auto atau perbarui @zuudevs/ze-json (>= 0.1.5).'
        );
    }

    // Warm-up startup: panaskan jalur wasm dan JIT sebelum ada request.
    const warmupPayload = '{"benchmarkWarmup":true}';
    for (let i = 0; i < 50; i += 1) {
        zeJson.openDocument(warmupPayload);
        JSON.parse(warmupPayload);
    }

    fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });

    server = app.listen(config.port, config.host, () => {
        console.log('[Raw benchmark] Server berjalan di http://' + config.host + ':' + config.port);
        console.log('[Raw benchmark] Data sampel mentah: ' + config.dataFile + ' (JSON Lines)');
        console.log('[Raw benchmark] Konfigurasi: maxTime=' + config.maxTime +
            's minSamples=' + config.minSamples + ' warmup=' + config.warmup +
            ' maxQueue=' + config.maxQueue + ' bodyLimit=' + config.bodyLimit +
            ' scanner=' + config.scanner);
        console.log('[Raw benchmark] ze_json ' + versions.zeJson +
            ' | Benchmark.js ' + versions.benchmarkJs + ' | Node ' + process.version);
        console.log('[Raw benchmark] POST /benchmark (raw JSON payload) -> {"status":"saved"}');
    });

    // Satu request = satu suite Benchmark.js (dapat puluhan detik), dan
    // request lain menunggu di antrian; matikan requestTimeout Node agar
    // koneksi tidak diputus di tengah pengukuran.
    server.requestTimeout = 0;

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((error) => {
    console.error('[Raw benchmark] Gagal memulai:', error.message);
    process.exitCode = 1;
});

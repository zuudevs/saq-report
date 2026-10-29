'use strict';

/**
 * Feeder payload nyata: menarik laporan SAQ dari database aplikasi (MongoDB,
 * jalur repository yang sama dengan server.js) lalu meng-POST-nya satu per
 * satu ke server raw benchmark (start:raw-benchmark). Server benchmark
 * tetap berjalan sebagai proses terisolasi sehingga pengukuran bersih.
 *
 * Dua bentuk payload dari data nyata:
 *   - saq-report        : satu dokumen laporan (root object, apa adanya)
 *   - saq-report-batch-N: envelope { "reports": [N laporan] } untuk membangun
 *                         payload bertubuh lebih besar dari data yang sama
 *
 * Pemakaian:
 *   npm run benchmark:json:real -- --limit 20 --repeats 5 --batch-size 10
 *   npm run benchmark:json:real -- --from-file data-laporan.json   # tanpa MongoDB
 *
 * Jalankan server benchmark terlebih dahulu di terminal terpisah:
 *   npm run start:raw-benchmark
 */

const path = require('node:path');

const DEFAULT_URL = process.env.JSON_BENCHMARK_URL || 'http://127.0.0.1:3100/benchmark';
const MAX_ZE_JSON_PAYLOAD_BYTES = 1024 * 1024; // batas region payload binding wasm

function readOptions(argv) {
    const options = {
        url: DEFAULT_URL,
        limit: 20,
        repeats: 1,
        batchSize: 0,
        batchLimit: 5,
        phase: 'measurement',
        fromFile: null,
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

        if (key === '--url') options.url = value;
        else if (key === '--limit') options.limit = Number(value);
        else if (key === '--repeats') options.repeats = Number(value);
        else if (key === '--batch-size') options.batchSize = Number(value);
        else if (key === '--batch-limit') options.batchLimit = Number(value);
        else if (key === '--phase') options.phase = value;
        else if (key === '--from-file') options.fromFile = value;
        else throw new Error('Opsi tidak dikenal: ' + key + '. Gunakan --help.');
    }

    if (options.help) return options;

    let parsedUrl;
    try {
        parsedUrl = new URL(options.url);
    } catch {
        throw new Error('URL benchmark tidak valid: ' + options.url);
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('URL benchmark harus menggunakan HTTP atau HTTPS.');
    }
    if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error('--limit harus bilangan bulat >= 1.');
    }
    if (!Number.isInteger(options.repeats) || options.repeats < 1) {
        throw new Error('--repeats harus bilangan bulat >= 1.');
    }
    if (!Number.isInteger(options.batchSize) || options.batchSize < 0) {
        throw new Error('--batch-size harus bilangan bulat >= 0 (0 = tanpa envelope).');
    }
    if (!Number.isInteger(options.batchLimit) || options.batchLimit < 1) {
        throw new Error('--batch-limit harus bilangan bulat >= 1.');
    }
    if (!['warmup', 'measurement'].includes(options.phase)) {
        throw new Error('--phase harus warmup atau measurement.');
    }

    return options;
}

function printHelp() {
    console.log(`Pemakaian:
  npm run benchmark:json:real -- [opsi]

Menarik laporan SAQ dari MongoDB lalu mengirimkannya ke server raw benchmark.
Pastikan server benchmark sudah berjalan (npm run start:raw-benchmark) dan
MongoDB dapat dijangkau seperti saat aplikasi normal dijalankan.

Opsi:
  --url URL        Endpoint benchmark (default: ${DEFAULT_URL})
  --limit N        Maksimum laporan tunggal yang dikirim (default 20)
  --repeats N      Berapa kali tiap payload dikirim ulang (default 1);
                   ulangan memberikan pasangan sampel untuk uji statistik
  --batch-size N   Kirim juga envelope {reports: [N laporan]} per potongan
                   data; 0 = hanya laporan tunggal (default 0)
  --batch-limit N  Maksimum potongan envelope yang dikirim (default 5)
  --phase P        Nilai header x-benchmark-phase: warmup|measurement (default measurement)
  --from-file PATH Baca array laporan dari file JSON alih-alih dari MongoDB
                   (format: [ ...laporan ] atau {"reports": [...]}) — berguna
                   saat MongoDB tidak berjalan atau untuk dataset tetap
  --help, -h       Tampilkan bantuan

Catatan: satu POST = satu suite Benchmark.js (±13 detik pada default server).
Hitung total durasi ≈ jumlah request × durasi per request.`);
}

// Shuffle deterministik (LCG sederhana dengan seed tetap) agar urutan payload
// teracak namun selalu dapat direproduksi antar-run.
function shuffleDeterministically(items) {
    let seed = 0xC0FFEE;
    const shuffled = [...items];

    function nextRandom() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    }

    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(nextRandom() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function buildPayloads(reports, options) {
    const payloads = [];

    // Laporan tunggal: root object sesuai kontrak Session ze_json.
    const singles = reports.slice(0, options.limit);
    singles.forEach((report, index) => {
        const body = JSON.stringify(report);
        payloads.push({
            workload: 'saq-report',
            label: 'saq-report#' + (report && report.id !== undefined ? report.id : index),
            body,
        });
    });

    // Envelope batch: beberapa laporan dalam satu root object untuk
    // menyediakan kelas ukuran besar dari data nyata.
    if (options.batchSize > 0) {
        const maxChunks = options.batchLimit;
        for (let start = 0, chunk = 0; start < reports.length && chunk < maxChunks; start += options.batchSize, chunk += 1) {
            const slice = reports.slice(start, start + options.batchSize);
            if (slice.length === 0) break;
            payloads.push({
                workload: 'saq-report-batch-' + slice.length,
                label: 'saq-report-batch-' + slice.length + '#' + chunk,
                body: JSON.stringify({ reports: slice }),
            });
        }
    }

    return payloads;
}

async function sendPayload(url, payload, phase, attempt, totalAttempts) {
    const startedAt = Date.now();
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-benchmark-phase': phase,
            'x-benchmark-workload': payload.workload,
        },
        body: payload.body,
    });
    const text = await response.text();
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (!response.ok || text !== '{"status":"saved"}') {
        throw new Error(
            'Pengiriman ' + payload.label + ' (ulang ke-' + attempt + '/' + totalAttempts +
            ') gagal: HTTP ' + response.status + ' — ' + text.slice(0, 300)
        );
    }
    console.log(
        '[' + payload.label + '] ulang ' + attempt + '/' + totalAttempts +
        ' -> tersimpan (' + Buffer.byteLength(payload.body, 'utf8') + ' byte, ' + elapsed + ' s)'
    );
}

async function main() {
    const options = readOptions(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

    console.log('[Feeder] Endpoint benchmark : ' + options.url);

    let reports;
    let usedMongo = false;
    if (options.fromFile) {
        // Sumber file: dataset tetap yang bisa direproduksi tanpa MongoDB.
        const fs = require('node:fs');
        const resolved = path.resolve(options.fromFile);
        const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        reports = Array.isArray(parsed)
            ? parsed
            : (parsed && Array.isArray(parsed.reports) ? parsed.reports : null);
        if (!reports) {
            throw new Error(
                'File ' + options.fromFile +
                ' harus berupa array laporan atau {"reports": [...]}'
            );
        }
        console.log('[Feeder] Sumber payload     : file ' + resolved +
            ' (' + reports.length + ' laporan, tanpa MongoDB)');
    } else {
        console.log('[Feeder] Menghubungkan MongoDB...');
        const { connectDB } = require('../config/database');
        const { initRepositories, reportRepo } = require('../repositories');

        await connectDB();
        await initRepositories();
        reports = reportRepo.read();
        usedMongo = true;
    }
    if (!Array.isArray(reports) || reports.length === 0) {
        throw new Error('Tidak ada laporan pada sumber data — tidak ada payload nyata untuk dikirim.');
    }

    const payloads = buildPayloads(reports, options);
    const oversized = payloads.filter((p) => Buffer.byteLength(p.body, 'utf8') >= MAX_ZE_JSON_PAYLOAD_BYTES);
    const sendable = payloads.filter((p) => Buffer.byteLength(p.body, 'utf8') < MAX_ZE_JSON_PAYLOAD_BYTES);
    if (oversized.length > 0) {
        console.warn('[Feeder] ' + oversized.length + ' payload >= 1 MiB dilewati (batas region ze_json): ' +
            oversized.map((p) => p.label).join(', '));
    }
    if (sendable.length === 0) {
        throw new Error('Semua payload melebihi 1 MiB — perkecil --batch-size.');
    }

    const schedule = [];
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        for (const payload of sendable) {
            schedule.push({ payload, repeat });
        }
    }
    const shuffled = shuffleDeterministically(schedule);

    const sizeSummary = sendable.map((p) => Buffer.byteLength(p.body, 'utf8'));
    console.log('[Feeder] Laporan pada sumber : ' + reports.length +
        ' (dikirim: ' + Math.min(options.limit, reports.length) + ' tunggal' +
        (options.batchSize > 0 ? ', ' + (sendable.length - Math.min(options.limit, reports.length)) + ' envelope' : '') + ')');
    console.log('[Feeder] Ukuran payload      : ' + Math.min(...sizeSummary) + '–' + Math.max(...sizeSummary) + ' byte');
    console.log('[Feeder] Total request       : ' + shuffled.length +
        ' (' + sendable.length + ' payload × ' + options.repeats + ' ulang)');

    let sent = 0;
    for (const entry of shuffled) {
        await sendPayload(options.url, entry.payload, options.phase, entry.repeat, options.repeats);
        sent += 1;
    }

    console.log('\n[Feeder] Selesai: ' + sent + ' request tersimpan ke file data server benchmark.');
    console.log('[Feeder] Analisis: baca file JSON Lines di server benchmark');
    console.log('          (pandas.read_json(..., lines=True), pasangkan per payload_sha256, uji Wilcoxon per workload).');

    if (usedMongo) {
        await require('mongoose').disconnect();
    }
    process.exit(0);
}

main().catch(async (error) => {
    console.error('[Feeder] Gagal:', error.message);
    try {
        const mongoose = require('mongoose');
        if (mongoose.connection.readyState === 1) {
            await mongoose.disconnect();
        }
    } catch { /* koneksi belum terbuka */ }
    process.exit(1);
});

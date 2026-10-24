'use strict';

const path = require('node:path');

require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
});

// Paksa mode benchmark sebelum middleware dibutuhkan. Server ini sengaja tidak
// memuat server.js, repository, MongoDB, cron, atau klien WhatsApp.
process.env.JSON_PARSER_BENCHMARK = '1';

const express = require('express');
const benchmark = require('../middleware/jsonParserBenchmark');

const app = express();
const PORT = Number(process.env.BENCHMARK_PORT) || 3100;
const HOST = process.env.BENCHMARK_HOST || '127.0.0.1';

app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, service: 'saq-report-json-benchmark' });
});

app.use(benchmark.middleware);

app.all('/benchmark', (req, res) => {
    if (!req.is('application/json')) {
        return res.status(415).json({
            ok: false,
            error: 'Content-Type harus application/json.',
        });
    }

    const value = req.body;
    const rootType = Array.isArray(value)
        ? 'array'
        : value === null
            ? 'null'
            : typeof value;

    return res.status(200).json({
        ok: true,
        message: 'Payload berhasil diproses JSON.parse; metrik benchmark dicatat.',
        rootType,
        keys: value !== null && typeof value === 'object' && !Array.isArray(value)
            ? Object.keys(value)
            : [],
    });
});

app.use((req, res) => {
    res.status(404).json({
        ok: false,
        error: 'Endpoint tidak ditemukan. Gunakan POST /benchmark atau GET /health.',
    });
});

app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    res.status(status).json({
        ok: false,
        error: status === 400
            ? 'Body JSON tidak valid atau bukan object/array.'
            : (error.message || 'Terjadi kesalahan pada server benchmark.'),
        type: error.type || 'benchmark.error',
    });
});

let server;
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[JSON benchmark] Menerima ' + signal + ', menutup server...');

    const closeServer = new Promise((resolve) => {
        if (!server) return resolve();
        server.close(resolve);
    });

    await closeServer;
    await benchmark.close();
    process.exit(0);
}

async function start() {
    await benchmark.initialize();

    server = app.listen(PORT, HOST, () => {
        console.log('[JSON benchmark] Server mandiri berjalan di http://' + HOST + ':' + PORT);
        console.log('[JSON benchmark] Health check: GET /health');
        console.log('[JSON benchmark] Kirim payload: POST /benchmark');
        console.log('[JSON benchmark] Mode ini tidak membutuhkan MongoDB atau Docker.');
    });

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch(async (error) => {
    console.error('[JSON benchmark] Gagal memulai:', error);
    await benchmark.close().catch(() => {});
    process.exitCode = 1;
});

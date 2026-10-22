/**
* server.js — Entry Point
*
* Tanggung jawab file ini hanya:
*  1. Setup Express + HTTP server
*  2. Pasang middleware global
*  3. Mount semua routes
*  4. Pasang error handler
*  5. Jalankan server + inisialisasi WhatsApp
*
* Tidak ada business logic di sini.
*/

'use strict';

// Best practice: load .env explicitly from project root
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const http    = require('path');   // hanya untuk __dirname resolution
const httpServer = require('http');
const path    = require('path');

const PATHS   = require('./config/paths');

// ─── Middleware ───────────────────────────────────────────────────────────────
const { multerErrorHandler, globalErrorHandler } = require('./middleware/errorHandler');
const jsonParserBenchmark = require('./middleware/jsonParserBenchmark');

// ─── Routes ───────────────────────────────────────────────────────────────────
const dashboardRoutes  = require('./routes/dashboardRoutes');
const asistenRoutes    = require('./routes/asistenRoutes');
const dosenRoutes      = require('./routes/dosenRoutes');
const matakuliahRoutes = require('./routes/matakuliahRoutes');
const jadwalRoutes     = require('./routes/jadwalRoutes');
const laporanRoutes    = require('./routes/laporanRoutes');
const rekapRoutes      = require('./routes/rekapRoutes');
const whatsappRoutes   = require('./routes/whatsappRoutes');
const settingRoutes    = require('./routes/settingRoutes');

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
const { initializeClient, isTargetClosedError } = require('./services/whatsapp/whatsappClient');
const { isTargetClosedError: _isTCE }           = require('./services/whatsapp/whatsappHelpers');
const { initDailyReminders } = require('./services/cronService');

// ─── Mongo / Repositories Init ─────────────────────────────────────────────
const { connectDB } = require('./config/database');
const { initRepositories } = require('./repositories');

// ─── App Setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = httpServer.createServer(app);
const PORT   = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', PATHS.VIEWS_DIR);

// Body parsers
app.use(express.urlencoded({ extended: true }));
app.use(
    jsonParserBenchmark.enabled
        ? jsonParserBenchmark.middleware
        : express.json()
);

// Static files (gambar laporan, dsb.)
app.use(express.static(PATHS.ROOT));

// ─── Route Mounting ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dashboard'));

app.use('/dashboard',   dashboardRoutes);
app.use('/asisten',     asistenRoutes);
app.use('/dosen',       dosenRoutes);
app.use('/matakuliah',  matakuliahRoutes);
app.use('/jadwal',     jadwalRoutes);
app.use('/laporan',     laporanRoutes);
app.use('/rekap',      rekapRoutes);
app.use('/whatsapp',   whatsappRoutes);
app.use('/settings',   settingRoutes);
app.use('/config',     settingRoutes);
app.use('/pengaturan', settingRoutes);

// Alias API WhatsApp status (backward-compat)
app.use('/api/whatsapp', whatsappRoutes);

// ─── Error Handling (harus paling akhir) ─────────────────────────────────────
app.use(multerErrorHandler);
app.use(globalErrorHandler);

initDailyReminders();

// ─── Process-level Error Handlers ────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    if (_isTCE(reason)) {
        console.warn('[PROCESS] Unhandled rejection karena browser target tertutup — diabaikan.');
        return;
    }
    console.error('[PROCESS] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    if (jsonParserBenchmark.enabled) {
        console.error('[PROCESS] Uncaught Exception:', error);
        return;
    }
    console.error('[PROCESS] Uncaught Exception:', error);
    // Tidak exit — biarkan web server tetap berjalan
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    server.close(async () => {
        try {
            await jsonParserBenchmark.close();
        } catch (error) {
            console.error('[JSON benchmark] Gagal menutup output:', error.message);
        }
        process.exit(0);
    });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// ─── Start Server ─────────────────────────────────────────────────────────────
async function start() {
    await jsonParserBenchmark.initialize();
    await connectDB();
    await initRepositories();

    server.listen(PORT, () => {
        console.log('🚀 Server berjalan di http://localhost:' + PORT);
        console.log('📱 WhatsApp QR  : http://localhost:' + PORT + '/whatsapp/qr');
        console.log('🤖 WA Dashboard : http://localhost:' + PORT + '/whatsapp');

        initializeClient();
    });
}

start().catch((err) => {
    console.error('[STARTUP] Failed to start server:', err);
    process.exit(1);
});

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

// ND-11 (Phase E, ukur HTTP end-to-end): gate boot-level untuk mematikan
// klien WhatsApp (puppeteer headless) + cron reminder saat instance hanya
// dipakai pengukuran. Handler/route/template TIDAK diubah — boundary
// `/rekap` identik dengan produksi (bukan perubahan perilaku aplikasi).
const WA_BOOT_DISABLED = process.env.SAQ_DISABLE_WHATSAPP === '1';

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
app.use(express.json());

// Static files (gambar laporan, dsb.)
app.use(express.static(PATHS.ROOT));

// ─── Route Mounting ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dashboard'));

app.use('/dashboard',   dashboardRoutes);
app.use('/asisten',     asistenRoutes);
app.use('/dosen',       dosenRoutes);
app.use('/matakuliah',  matakuliahRoutes);
app.use('/jadwal',      jadwalRoutes);
app.use('/laporan',     laporanRoutes);
app.use('/rekap',       rekapRoutes);
app.use('/whatsapp',    whatsappRoutes);
app.use('/settings',    settingRoutes);
app.use('/config',      settingRoutes);
app.use('/pengaturan',  settingRoutes);

// Alias API WhatsApp status (backward-compat)
app.use('/api/whatsapp', whatsappRoutes);

// ─── Error Handling (harus paling akhir) ─────────────────────────────────────
app.use(multerErrorHandler);
app.use(globalErrorHandler);

if (!WA_BOOT_DISABLED) {
    initDailyReminders();
}

// ─── Process-level Error Handlers ────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    if (_isTCE(reason)) {
        console.warn('[PROCESS] Unhandled rejection karena browser target tertutup — diabaikan.');
        return;
    }
    console.error('[PROCESS] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[PROCESS] Uncaught Exception:', error);
    // Tidak exit — biarkan web server tetap berjalan
});

// ─── Start Server ─────────────────────────────────────────────────────────────
async function start() {
    await connectDB();
    await initRepositories();
    
    // SAQ_BIND_HOST (opsional, boot-level — knob ND-11 koeksistensi):
    // batasi interface listen untuk instance benchmark (127.0.0.1) agar
    // tidak reachable dari jaringan. Produksi: env absen → undefined →
    // perilaku eksisting (semua interface) TIDAK berubah.
    server.listen(PORT, process.env.SAQ_BIND_HOST || undefined, () => {
        console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
        if (WA_BOOT_DISABLED) {
            console.log('📴 WhatsApp/cron boot dimatikan (SAQ_DISABLE_WHATSAPP=1) — mode pengukuran ND-11.');
        } else {
            console.log(`📱 WhatsApp QR  : http://localhost:${PORT}/whatsapp/qr`);
            console.log(`🤖 WA Dashboard : http://localhost:${PORT}/whatsapp`);

            initializeClient();
        }
    });
}

start().catch((err) => {
    console.error('[STARTUP] Failed to start server:', err);
    process.exit(1);
});

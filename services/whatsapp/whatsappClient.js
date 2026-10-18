const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode-terminal');
const QRCode  = require('qrcode');

const { isTargetClosedError } = require('./whatsappHelpers');
const { handleIncomingMessage } = require('./messageHandler');

// ─── Paths ─────────────────────────────────────────────────────────────────────

const AUTH_DATA_PATH = path.resolve(__dirname, '../../.wwebjs_auth');
const SESSION_DIR    = path.join(AUTH_DATA_PATH, 'session');
const DEFAULT_DIR    = path.join(SESSION_DIR, 'Default');

// ─── Configuration Constants ───────────────────────────────────────────────────

const INITIAL_RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS     = 60_000;
const MAX_CONSECUTIVE_FAILURES   = 10;
const INIT_WATCHDOG_TIMEOUT_MS   = 120_000; // Batas waktu maksimal inisialisasi (2 menit)
const HEALTH_CHECK_INTERVAL_MS   = 60_000;  // Pengecekan liveness berkala setiap 60 detik

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
    client:             null,
    currentQRCode:      null,
    status:             'disconnected', // 'disconnected' | 'initializing' | 'qr_ready' | 'authenticated' | 'ready' | 'auth_failed' | 'reconnecting' | 'restarting' | 'error'
    loadingPercent:     0,
    loadingMessage:     '',
    reconnectTimer:     null,
    reconnectAttempts:  0,
    isInitializing:     false,
    isRestarting:       false,
    healthCheckTimer:   null,
    lastError:          null,
    lastConnectedAt:    null,
};

// ─── Getters (ekspor state buat routes & frontend) ─────────────────────────────

const getStatus          = () => state.status;
const getQRCode          = () => state.currentQRCode;
const getClient          = () => state.client;
const getLoadingProgress = () => ({
    percent: state.loadingPercent,
    message: state.loadingMessage,
});
const getDiagnostics    = () => ({
    status:            state.status,
    reconnectAttempts: state.reconnectAttempts,
    isInitializing:    state.isInitializing,
    lastError:         state.lastError?.message || null,
    lastConnectedAt:   state.lastConnectedAt,
});

// ─── Internal Process & Lock Cleanup Helpers ─────────────────────────────────

function clearReconnectTimer() {
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }
}

/**
 * Mematikan seluruh pohon proses (process tree) berdasarkan PID.
 * Menjamin proses utama Chrome beserta semua child proses (renderer, GPU, utility) mati seketika.
 */
function killProcessTreeByPid(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
                windowsHide: true,
                timeout: 5000,
            });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch (_) {}
}

/**
 * Membersihkan proses zombie Chrome yang tertinggal dari sesi wwebjs.
 * Menggunakan PowerShell spawnSync dengan argumen terisolasi agar bebas dari masalah escaping quotes di Windows.
 */
function killOrphanedWwebjsBrowsers() {
    if (process.platform !== 'win32') return;
    try {
        const script = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*wwebjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true,
            timeout: 10000,
        });
    } catch (_) {}
}

/**
 * Menghapus stale lock files Chromium di direktori session.
 * Jika Chrome mati mendadak (crash/kill), Chromium meninggalkan lockfile yang membuat Puppeteer
 * melempar error "The browser is already running for ...".
 */
function removeStaleSessionLocks() {
    if (!fs.existsSync(SESSION_DIR)) return;
    const lockFiles = [
        'lockfile',
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        'DevToolsActivePort',
    ];
    for (const f of lockFiles) {
        const fullPath = path.join(SESSION_DIR, f);
        try {
            if (fs.existsSync(fullPath)) {
                fs.rmSync(fullPath, { force: true });
                console.log(`[WHATSAPP] Membersihkan stale lock file: ${f}`);
            }
        } catch (_) {}
    }
}

/**
 * Self-healing: Menghapus cache sementara Chromium jika terjadi kegagalan berulang.
 * PENTING: Hanya menghapus disposable caches (Cache, Code Cache, GPUCache, blob).
 * Kredensial login (IndexedDB, Local Storage, cookies) TIDAK disentuh sama sekali,
 * sehingga sesi WhatsApp Web tetap aman tanpa perlu scan QR ulang!
 */
function purgeDisposableCaches() {
    if (!fs.existsSync(DEFAULT_DIR)) return;
    const disposableDirs = [
        'Cache',
        'Code Cache',
        'GPUCache',
        'DawnGraphiteCache',
        'DawnWebGPUCache',
        'blob_storage',
    ];
    for (const d of disposableDirs) {
        const full = path.join(DEFAULT_DIR, d);
        try {
            if (fs.existsSync(full)) {
                fs.rmSync(full, { recursive: true, force: true });
                console.log(`[WHATSAPP] [Self-Healing] Membersihkan cache sementara: ${d}`);
            }
        } catch (_) {}
    }
    const crashpad = path.join(SESSION_DIR, 'Crashpad');
    try {
        if (fs.existsSync(crashpad)) {
            fs.rmSync(crashpad, { recursive: true, force: true });
        }
    } catch (_) {}
}

/**
 * Destroy client secara aman dengan timeout, pembersihan listeners,
 * pembunuhan proses, dan pelepasan file lock.
 */
async function destroyClientSafe() {
    stopHealthCheck();
    
    const clientToDestroy = state.client;
    const pid = clientToDestroy?.pupBrowser?.process()?.pid;
    
    if (clientToDestroy) {
        try {
            clientToDestroy.removeAllListeners();
        } catch (_) {}
        
        try {
            // Batasi waktu client.destroy() 4 detik agar tidak hang jika CDP socket macet
            await Promise.race([
                clientToDestroy.destroy().catch(() => {}),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), 4000)),
            ]);
        } catch (_) {}
    }
    
    // Force kill jika proses Chrome masih hidup
    if (pid) {
        killProcessTreeByPid(pid);
    }
    
    // Bersihkan proses zombie & stale lockfile di OS
    killOrphanedWwebjsBrowsers();
    removeStaleSessionLocks();
    
    state.client        = null;
    state.currentQRCode = null;
    
    // Jeda singkat agar OS kernel Windows menyelesaikan pelepasan file handles & socket ports
    await new Promise((r) => setTimeout(r, 600));
}

// ─── Health Check / Liveness Watcher ───────────────────────────────────────────

function startHealthCheck() {
    stopHealthCheck();
    state.healthCheckTimer = setInterval(async () => {
        if (state.status !== 'ready' || !state.client?.pupPage) return;
        try {
            const isAlive = await Promise.race([
                state.client.pupPage.evaluate(() => {
                    return typeof window !== 'undefined' && typeof window.WWebJS !== 'undefined';
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('HealthCheck timeout')), 10000)),
            ]);
            
            if (!isAlive) {
                console.warn('[WHATSAPP] Health check mendeteksi sesi WhatsApp Web tidak merespon. Menjadwalkan restart...');
                await restartClient();
            }
        } catch (e) {
            if (isTargetClosedError(e)) {
                console.warn('[WHATSAPP] Health check mendeteksi browser tertutup. Menjadwalkan restart...');
                await restartClient();
            }
        }
    }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck() {
    if (state.healthCheckTimer) {
        clearInterval(state.healthCheckTimer);
        state.healthCheckTimer = null;
    }
}

// ─── Reconnection Handler ─────────────────────────────────────────────────────

function scheduleReconnect(trigger) {
    if (state.reconnectTimer) return;
    
    state.reconnectAttempts += 1;
    
    if (state.reconnectAttempts > MAX_CONSECUTIVE_FAILURES) {
        console.error(`[WHATSAPP] Gagal terhubung setelah ${MAX_CONSECUTIVE_FAILURES} percobaan berturut-turut. Menunggu restart manual via /whatsapp/restart.`);
        state.status = 'error';
        return;
    }
    
    // Exponential backoff dengan jitter acak halus
    const baseDelay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * Math.pow(2, Math.max(0, state.reconnectAttempts - 1)),
        MAX_RECONNECT_DELAY_MS
    );
    const jitter = Math.floor(Math.random() * 1000);
    const delay  = baseDelay + jitter;
    
    state.status = 'reconnecting';
    console.warn(`[WHATSAPP] Menjadwalkan reconnect (${trigger}) dalam ${delay}ms (percobaan ke-${state.reconnectAttempts}/${MAX_CONSECUTIVE_FAILURES})`);
    
    state.reconnectTimer = setTimeout(async () => {
        state.reconnectTimer = null;
        await initializeClient({ reason: `reconnect_${trigger}` });
    }, delay);
}

// ─── Initialization ────────────────────────────────────────────────────────────

async function initializeClient(options = {}) {
    if (state.isInitializing) {
        console.log('[WHATSAPP] Sudah sedang inisialisasi, permintaan baru diabaikan.');
        return;
    }
    
    state.isInitializing = true;
    clearReconnectTimer();
    state.status = 'initializing';
    console.log(`[WHATSAPP] Memulai inisialisasi (${options.reason || 'startup'})...`);
    
    // 1. Pre-flight cleanup: pastikan client sebelumnya, zombie proses, & lockfile bersih tuntas
    await destroyClientSafe();
    
    // 2. Self-healing: jika kegagalan berulang (>= 3), bersihkan cache sementara yang mungkin korup
    if (state.reconnectAttempts >= 3) {
        console.warn(`[WHATSAPP] Terdeteksi kegagalan berulang (ke-${state.reconnectAttempts}). Menjalankan self-healing cache...`);
        purgeDisposableCaches();
    }
    
    // 3. Konfigurasi Client & Puppeteer yang terisolasi dan stabil
    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: AUTH_DATA_PATH,
        }),
        puppeteer: {
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            headless: true,
            protocolTimeout: 180000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--disable-extensions',
                '--window-size=1280,800',
            ],
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    });
    
    state.client = client;
    
    // ── Event: QR ──────────────────────────────────────────────────────────────
    client.on('qr', async (qr) => {
        qrcode.generate(qr, { small: true });
        try {
            state.currentQRCode = await QRCode.toDataURL(qr);
            state.status        = 'qr_ready';
            console.log('[WHATSAPP] QR Code siap di /whatsapp/qr');
        } catch (err) {
            console.error('[WHATSAPP] Gagal generate QR untuk web:', err);
        }
    });
    
    // ── Event: Ready ───────────────────────────────────────────────────────────
    client.on('ready', () => {
        state.status            = 'ready';
        state.currentQRCode     = null;
        state.loadingPercent    = 100;
        state.loadingMessage    = 'Bot Siap';
        state.reconnectAttempts = 0;
        state.isInitializing    = false;
        state.isRestarting      = false;
        state.lastConnectedAt   = new Date();
        state.lastError         = null;
        console.log('[WHATSAPP] ✅ Client siap. Bot terhubung.');
        startHealthCheck();
    });
    
    // ── Event: Authenticated ───────────────────────────────────────────────────
    client.on('authenticated', () => {
        state.status = 'authenticated';
        console.log('[WHATSAPP] ✅ Authenticated (Sinkronisasi data WhatsApp Web sedang berjalan)...');
    });

    // ── Event: Loading Screen ──────────────────────────────────────────────────
    client.on('loading_screen', (percent, message) => {
        state.loadingPercent = percent;
        state.loadingMessage = message;
        console.log(`[WHATSAPP] ⏳ Sinkronisasi data: ${percent}% - ${message}`);
    });

    // ── Event: Change State ────────────────────────────────────────────────────
    client.on('change_state', (newState) => {
        console.log(`[WHATSAPP] ℹ️ WhatsApp State: ${newState}`);
    });
    
    // ── Event: Auth Failure ────────────────────────────────────────────────────
    client.on('auth_failure', async (msg) => {
        state.status         = 'auth_failed';
        state.currentQRCode  = null;
        state.isInitializing = false;
        console.error('[WHATSAPP] ❌ Auth gagal:', msg);
        await destroyClientSafe();
        scheduleReconnect('auth_failure');
    });
    
    // ── Event: Disconnected ────────────────────────────────────────────────────
    client.on('disconnected', async (reason) => {
        state.status         = 'disconnected';
        state.currentQRCode  = null;
        state.isInitializing = false;
        console.log('[WHATSAPP] ❌ Disconnected:', reason);
        
        await destroyClientSafe();
        if (!state.isRestarting) {
            scheduleReconnect('disconnected');
        }
    });
    
    // ── Event: Message ─────────────────────────────────────────────────────────
    client.on('message_create', async (message) => {
        await handleIncomingMessage(message, state.client);
    });
    
    // ── Inisialisasi dengan Watchdog Timer ──────────────────────────────────────
    try {
        const initPromise = client.initialize();
        const watchdogPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Inisialisasi melebihi batas waktu ${INIT_WATCHDOG_TIMEOUT_MS / 1000} detik (Watchdog Timeout)`));
            }, INIT_WATCHDOG_TIMEOUT_MS);
        });
        
        await Promise.race([initPromise, watchdogPromise]);
        console.log('[WHATSAPP] initialize() berhasil dipanggil.');
    } catch (err) {
        state.lastError = err;
        const errMsg = err?.message || String(err);
        
        if (isTargetClosedError(err)) {
            console.warn('[WHATSAPP] Browser target tertutup saat initialize(). Akan reconnect.');
        } else if (errMsg.includes('already running') || errMsg.includes('userDataDir')) {
            console.warn('[WHATSAPP] Terdeteksi browser lock saat initialize(). Membersihkan sisa proses & lock file...');
        } else if (errMsg.includes('Watchdog Timeout')) {
            console.warn(`[WHATSAPP] ⚠️ ${errMsg}. Membersihkan browser menggantung dan mencoba ulang...`);
        } else {
            console.error('[WHATSAPP] Gagal initialize():', errMsg);
        }
        
        // BEST PRACTICE: Hancurkan client & proses Chrome yang gagal sebelum retry
        await destroyClientSafe();
        
        state.isInitializing = false;
        state.isRestarting   = false;
        scheduleReconnect('initialize_failed');
    } finally {
        if (state.status === 'initializing') {
            state.isInitializing = false;
        }
    }
}

// ─── Restart (untuk route /whatsapp/restart) ──────────────────────────────────

async function restartClient() {
    state.isRestarting      = true;
    state.status            = 'restarting';
    state.currentQRCode     = null;
    state.reconnectAttempts = 0;
    clearReconnectTimer();
    await destroyClientSafe();
    await initializeClient({ reason: 'manual_restart' });
}

const getChats = async () => {
    if (!state.client || state.status !== 'ready') return [];
    try {
        const chats = await state.client.getChats();
        return chats.map(chat => ({
            id:          chat.id._serialized,
            name:        chat.name,
            isGroup:     chat.isGroup,
            unreadCount: chat.unreadCount,
            timestamp:   chat.timestamp,
        }));
    } catch (err) {
        console.error('[WHATSAPP] Gagal mengambil daftar chat:', err);
        return [];
    }
};

module.exports = {
    initializeClient,
    restartClient,
    getStatus,
    getQRCode,
    getClient,
    getChats,
    getLoadingProgress,
    getDiagnostics,
    isTargetClosedError,
};

// ─── Graceful Shutdown Multi-Signal (SIGINT, SIGTERM, SIGUSR2 Nodemon, SIGHUP) ─
let isShuttingDown = false;
const cleanExit = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[WHATSAPP] Menerima sinyal ${signal || 'SHUTDOWN'}: mematikan bot & membersihkan browser proses...`);
    try {
        stopHealthCheck();
        clearReconnectTimer();
        await destroyClientSafe();
    } catch (_) {}
    process.exit(0);
};

process.once('SIGINT',  () => cleanExit('SIGINT'));
process.once('SIGTERM', () => cleanExit('SIGTERM'));
process.once('SIGUSR2', () => cleanExit('SIGUSR2')); // Sinyal restart Nodemon
process.once('SIGHUP',  () => cleanExit('SIGHUP'));

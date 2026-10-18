'use strict';

const mongoose = require('mongoose');

function getMongoHostForLog(uri) {
    // Avoid logging credentials (username/password).
    // Example: mongodb://user:pass@host:27017/db -> host:27017
    try {
        const noScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
        const withoutCred = noScheme.includes('@')
            ? noScheme.split('@').slice(1).join('@')
            : noScheme;
        return withoutCred.split('/')[0] || 'host';
    } catch (_) {
        return 'host';
    }
}

/**
 * Koneksi ke MongoDB menggunakan Mongoose.
 * Menggunakan MONGO_URL dari environment variable.
 */
async function connectDB() {
    // Railway sering memberi 2 URL:
    // - MONGO_URL (internal) = biasanya cuma resolvable di network Railway
    // - MONGO_PUBLIC_URL = URL proxy yang bisa diakses dari mesin lokal
    // Best practice: coba berurutan, supaya dev/local tetap jalan.
    const candidates = [
        process.env.MONGO_URL,
        process.env.MONGO_PUBLIC_URL,
    ].filter(Boolean);

    if (candidates.length === 0) {
        throw new Error('MongoDB URI tidak ditemukan. Pastikan `MONGO_URL` atau `MONGO_PUBLIC_URL` sudah dikonfigurasi di environment/.env.');
    }

    let lastErr = null;
    const options = {
        // Mongoose 7+ sudah tidak butuh useNewUrlParser / useUnifiedTopology
        serverSelectionTimeoutMS: 10000,  // Timeout 10 detik untuk initial connect
        socketTimeoutMS:          45000,  // Timeout 45 detik untuk operasi
    };

    for (const uri of candidates) {
        try {
            await mongoose.connect(uri, options);
            console.log(`✅ [MongoDB] Terhubung ke database via ${getMongoHostForLog(uri)}.`);
            return;
        } catch (err) {
            lastErr = err;
            console.error(`❌ [MongoDB] Gagal terhubung via ${getMongoHostForLog(uri)}:`, err.message);
            try {
                if (mongoose.connection) await mongoose.disconnect();
            } catch (_) {}
        }
    }

    // Pas semua URI gagal.
    throw lastErr;
}

// Attach connection lifecycle listeners once (after connect succeeds).
mongoose.connection.on('error', (err) => {
    console.error('❌ [MongoDB] Connection error:', err.message);
});

mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  [MongoDB] Disconnected dari database.');
});

mongoose.connection.on('reconnected', () => {
    console.log('🔄 [MongoDB] Reconnected ke database.');
});

module.exports = { connectDB };

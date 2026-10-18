const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const AppError = require('../config/AppError');
const PATHS  = require('../config/paths');

const ALLOWED_MIME = /jpeg|jpg|png|gif|webp/;
const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB (tanda tangan biasanya kecil)

// Pastikan folder tujuan ada
try {
    fs.mkdirSync(PATHS.TTD_DIR, { recursive: true });
} catch (_) {}

const storage = multer.diskStorage({
    destination(req, file, cb) {
        try {
            fs.mkdirSync(PATHS.TTD_DIR, { recursive: true });
            cb(null, PATHS.TTD_DIR);
        } catch (err) {
            cb(new AppError(`Gagal membuat direktori TTD: ${err.message}`, 500));
        }
    },

    filename(req, file, cb) {
        // Nama file: ttd_<timestamp>.<ext>
        const timestamp = Date.now();
        cb(null, `ttd_${timestamp}${path.extname(file.originalname).toLowerCase()}`);
    },
});

function fileFilter(req, file, cb) {
    const extValid  = ALLOWED_MIME.test(path.extname(file.originalname).toLowerCase());
    const mimeValid = ALLOWED_MIME.test(file.mimetype);

    if (extValid && mimeValid) {
        cb(null, true);
    } else {
        cb(new AppError('Hanya file gambar (jpeg/jpg/png/gif/webp) yang diizinkan untuk tanda tangan.', 400));
    }
}

const uploadTtd = multer({ storage, limits: { fileSize: MAX_SIZE_BYTES }, fileFilter });

module.exports = uploadTtd;

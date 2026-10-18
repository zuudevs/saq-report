const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const AppError = require('../config/AppError');
const PATHS  = require('../config/paths');

const ALLOWED_MIME = /jpeg|jpg|png|gif/;
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.diskStorage({
    destination(req, file, cb) {
        const now  = new Date();
        const year  = now.getFullYear().toString();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day   = String(now.getDate()).padStart(2, '0');

        const uploadDir = path.join(PATHS.UPLOAD_DIR, year, month, day);
        try {
            fs.mkdirSync(uploadDir, { recursive: true });
            cb(null, uploadDir);
        } catch (err) {
            cb(new AppError(`Gagal membuat direktori upload: ${err.message}`, 500));
        }
    },

    filename(req, file, cb) {
        const timestamp = Date.now();
        cb(null, `laporan_${timestamp}${path.extname(file.originalname)}`);
    },
});

function fileFilter(req, file, cb) {
    const extValid  = ALLOWED_MIME.test(path.extname(file.originalname).toLowerCase());
    const mimeValid = ALLOWED_MIME.test(file.mimetype);

    if (extValid && mimeValid) {
        cb(null, true);
    } else {
        cb(new AppError('Hanya file gambar (jpeg/jpg/png/gif) yang diizinkan.', 400));
    }
}

const upload = multer({ storage, limits: { fileSize: MAX_SIZE_BYTES }, fileFilter });

module.exports = upload;

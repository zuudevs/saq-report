const AppError = require('../config/AppError');

/**
 * Tangani error dari multer secara khusus sebelum error handler umum.
 * Harus dipasang SEBELUM globalErrorHandler.
 */
function multerErrorHandler(err, req, res, next) {
    const { MulterError } = require('multer');
    if (err instanceof MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'Ukuran file melebihi batas 5MB.'
            : `Upload error: ${err.message}`;
        return next(new AppError(message, 400));
    }
    next(err);
}

/**
 * Global error handler Express (4 parameter = error middleware).
 * Pasang PALING AKHIR di app.use().
 */
function globalErrorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    const statusCode = err.statusCode || 500;
    const isOperational = err.isOperational === true;

    // Log selalu — tapi detail stack hanya di non-production
    if (process.env.NODE_ENV !== 'production') {
        console.error(`[ERROR ${statusCode}]`, err.stack || err.message);
    } else {
        console.error(`[ERROR ${statusCode}]`, err.message);
    }

    // Kalau request minta JSON (API), balas JSON
    if (req.accepts('json') && !req.accepts('html')) {
        return res.status(statusCode).json({
            success: false,
            error: isOperational ? err.message : 'Terjadi kesalahan internal.',
        });
    }

    // Untuk halaman web, kirim pesan sederhana
    res.status(statusCode).send(
        isOperational
            ? `<b>Error ${statusCode}:</b> ${err.message}`
            : `<b>Error 500:</b> Terjadi kesalahan internal. Silakan coba lagi.`
    );
}

module.exports = { multerErrorHandler, globalErrorHandler };

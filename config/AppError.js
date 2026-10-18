/**
 * Custom error class untuk membedakan error operasional (expected)
 * dari error programmer (unexpected bugs).
 */
class AppError extends Error {
    /**
     * @param {string} message  - Pesan error yang informatif
     * @param {number} statusCode - HTTP status code (default: 500)
     */
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true; // Tandai sebagai error yang bisa diprediksi

        // Capture stack trace, excluding constructor call
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = AppError;

const AppError = require('../config/AppError');

/**
 * Membungkus async route handler sehingga error otomatis diteruskan ke next().
 * Ini menghilangkan kebutuhan try-catch berulang di setiap route.
 *
 * @param {Function} fn - Async route handler
 */
const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Generate ID sederhana dengan prefix + timestamp.
 */
const generateId = (prefix) => `${prefix}_${Date.now().toString().slice(-6)}`;

module.exports = { asyncHandler, generateId };

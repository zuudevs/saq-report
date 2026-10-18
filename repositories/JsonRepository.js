const fs   = require('fs');
const AppError = require('../config/AppError');

/**
 * Generic repository untuk baca/tulis file JSON.
 * Semua entity-specific repository extend class ini.
 */
class JsonRepository {
    /**
     * @param {string} filePath     - Absolute path ke file JSON
     * @param {string} rootKey      - Key root di JSON (misal: "assistants"). Null = array root.
     * @param {*}      defaultValue - Nilai default jika file tidak ditemukan
     */
    constructor(filePath, rootKey = null, defaultValue = []) {
        this.filePath     = filePath;
        this.rootKey      = rootKey;
        this.defaultValue = defaultValue;
    }

    /**
     * Membaca data dari file JSON.
     * @returns {*} Data yang tersimpan
     * @throws {AppError} Jika file corrupt / tidak bisa dibaca setelah retry
     */
    read() {
        try {
            const raw  = fs.readFileSync(this.filePath, 'utf8');
            const json = JSON.parse(raw);
            return this.rootKey ? (json[this.rootKey] ?? this.defaultValue) : json;
        } catch (err) {
            if (err.code === 'ENOENT') {
                // File belum ada — kembalikan default, jangan crash
                return this.defaultValue;
            }
            // File ada tapi corrupt atau permission issue
            throw new AppError(
                `Gagal membaca ${this.filePath}: ${err.message}`,
                500
            );
        }
    }

    /**
     * Menulis data ke file JSON secara atomic (write ke tmp dulu, lalu rename).
     * @param {*} data - Data yang akan disimpan
     * @throws {AppError} Jika gagal menulis
     */
    write(data) {
        const tmpPath = `${this.filePath}.tmp`;
        try {
            const payload = this.rootKey
                ? JSON.stringify({ [this.rootKey]: data }, null, 2)
                : JSON.stringify(data, null, 2);

            fs.writeFileSync(tmpPath, payload, 'utf8');
            fs.renameSync(tmpPath, this.filePath); // atomic swap
        } catch (err) {
            // Bersihkan tmp file jika ada
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            throw new AppError(
                `Gagal menulis ${this.filePath}: ${err.message}`,
                500
            );
        }
    }
}

module.exports = JsonRepository;

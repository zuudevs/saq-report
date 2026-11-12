const fs   = require('fs');
const AppError = require('../config/AppError');
const { countJsonBytes, valueLength } = require('./zeJsonBinding');

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
     * ND-5 (read-only lazy): nilai yang identik dengan `read().length`
     * tanpa materialisasi penuh dokumen (structural count via ze_json).
     * Jalur ze_json opt-in — dipakai call-site dengan SAQ_JSON_ENGINE=ze;
     * baseline read() tidak diubah. Parity diunci oleh
     * scripts/check-json-lazy-parity.js.
     * @returns {number|undefined} nilai `.length` aplikasi
     * @throws {AppError} JSON corrupt (kontrak sama dengan read())
     * @throws {TypeError} parity `.length` pada default null/undefined atau
     *                     root null tanpa rootKey (identik baseline caller)
     */
    readCount() {
        let raw;
        try {
            raw = fs.readFileSync(this.filePath); // Buffer — bytes asli untuk ze_json
        } catch (err) {
            if (err.code === 'ENOENT') {
                // Parity: baseline read() mengembalikan defaultValue lalu
                // caller memanggil .length — replikasi lewat helper.
                return valueLength(this.defaultValue);
            }
            throw new AppError(
                `Gagal membaca ${this.filePath}: ${err.message}`,
                500
            );
        }
        try {
            return countJsonBytes(raw, this.rootKey, this.defaultValue);
        } catch (err) {
            // Parity LOKASI error (bukan hanya jenis):
            //  - Dengan rootKey: TypeError `json[rootKey]` pada root null
            //    terjadi DI DALAM read() baseline (try/catch) -> AppError 500.
            //  - Tanpa rootKey: TypeError `.length` pada root null terjadi
            //    di CALL-SITE (di luar read()) -> diteruskan apa adanya.
            if (this.rootKey === null && err instanceof TypeError) {
                throw err;
            }
            // JSON corrupt: kontrak error sama dengan read() (AppError 500).
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

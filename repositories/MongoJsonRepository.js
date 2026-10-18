'use strict';

const JsonRepository = require('./JsonRepository');
const JsonStoreModel = require('../models/JsonStore');

let indexesReady = false;
let indexesReadyPromise = null;

async function ensureJsonStoreIndexes() {
    if (indexesReady) return;
    if (!indexesReadyPromise) {
        indexesReadyPromise = JsonStoreModel.init()
            .then(() => {
                indexesReady = true;
            })
            .catch((err) => {
                // Jika auto-index di prod dimatikan, error ini tidak akan fatal untuk running app.
                console.error('[MongoDB] Failed to init JsonStore indexes (non-fatal):', err);
                indexesReadyPromise = null;
            });
    }
    return indexesReadyPromise;
}

function cloneJson(value) {
    // Repo data semuanya JSON-compatible (array/object/string/number).
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Repository MongoDB dengan interface sama:
 * - read(): sinkron (ambil dari cache)
 * - write(data): sinkron (update cache, lalu persist async)
 *
 * Tujuan: mempertahankan perilaku code existing (route/service) tanpa ubah pemanggilan.
 */
class MongoJsonRepository {
    /**
     * @param {string} filePath
     * @param {string|null} rootKey
     * @param {*} defaultValue
     * @param {string} storeKey
     */
    constructor(filePath, rootKey = null, defaultValue = [], storeKey) {
        if (!storeKey) throw new Error('MongoJsonRepository: storeKey wajib.');

        this.seedRepo = new JsonRepository(filePath, rootKey, defaultValue);
        this.storeKey = storeKey;

        this._cache = undefined;
        this._cacheLoaded = false;

        // Menjaga urutan persist write agar tidak saling timpa.
        this._persistChain = Promise.resolve();
    }

    async init() {
        if (this._cacheLoaded) return;

        await ensureJsonStoreIndexes();

        const doc = await JsonStoreModel.findOne({ key: this.storeKey }).lean();
        if (doc && doc.value !== undefined) {
            this._cache = doc.value;
            this._cacheLoaded = true;
            console.log(`[MongoDB] Loaded '${this.storeKey}' from MongoDB.`);
            return;
        }

        // Jika koleksi belum ada, seed dari JSON file yang sudah ada.
        this._cache = this.seedRepo.read();
        console.log(`[MongoDB] Seed '${this.storeKey}' from JSON file.`);

        await JsonStoreModel.updateOne(
            { key: this.storeKey },
            { $set: { value: this._cache } },
            { upsert: true }
        );

        this._cacheLoaded = true;
    }

    read() {
        if (!this._cacheLoaded) {
            // Fallback aman sebelum init() dipanggil.
            return cloneJson(this.seedRepo.read());
        }
        return cloneJson(this._cache);
    }

    write(data) {
        // Sinkron: update cache dulu supaya handler yang langsung baca setelah write
        // tetap konsisten.
        this._cache = cloneJson(data);
        this._cacheLoaded = true;

        // Persist async: tidak mengubah signature existing repo.write().
        const payload = cloneJson(data);
        this._persistChain = this._persistChain
            .then(async () => {
                await JsonStoreModel.updateOne(
                    { key: this.storeKey },
                    { $set: { value: payload } },
                    { upsert: true }
                );
            })
            .catch((err) => {
                console.error(`[MongoDB] Failed to persist '${this.storeKey}':`, err);
            });
    }
}

module.exports = MongoJsonRepository;


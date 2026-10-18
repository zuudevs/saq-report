'use strict';

const mongoose = require('mongoose');

const JsonStoreSchema = new mongoose.Schema(
    {
        // Key tunggal untuk setiap "repo" (assistants/courses/schedules/etc)
        key: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        // value menyimpan langsung output repo.read() (array atau object)
        value: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
        },
    },
    {
        collection: 'json_store',
        versionKey: false,
        timestamps: true,
    }
);

module.exports = mongoose.models.JsonStore || mongoose.model('JsonStore', JsonStoreSchema);


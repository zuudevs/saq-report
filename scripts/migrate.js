#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

/**
 * Jalankan dengan: npm run migrate:up
 * atau: node scripts/migrate.js up
 */

async function connectDB() {
    const uri = process.env.MONGO_URL || 'mongodb://mongo:yourpassword@localhost:27017';
    try {
        await mongoose.connect(uri);
        console.log('✅ Connected to MongoDB');
    } catch (err) {
        console.error('❌ Failed to connect:', err.message);
        process.exit(1);
    }
}

async function migrateUp() {
    try {
        await connectDB();

        // Contoh: Tambah index pada collections
        // db.collection('schedules').createIndex({ jadwal: 1 });
        // db.collection('lecturers').createIndex({ dosen: 1 });

        console.log('✅ Migration up completed');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err);
        process.exit(1);
    }
}

async function migrateDown() {
    try {
        await connectDB();

        // Contoh: Drop index atau hapus field
        // db.collection('schedules').dropIndex('jadwal_1');

        console.log('✅ Migration down completed');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration rollback failed:', err);
        process.exit(1);
    }
}

const command = process.argv[2] || 'up';

if (command === 'up') {
    migrateUp();
} else if (command === 'down') {
    migrateDown();
} else {
    console.error('❌ Unknown command:', command);
    console.log('Usage: node scripts/migrate.js [up|down]');
    process.exit(1);
}

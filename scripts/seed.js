#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Import models (sesuaikan dengan struktur model kamu)
// const Schedule = require('../models/Schedule');
// const Lecturer = require('../models/Lecturer');
// const Course = require('../models/Course');

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

async function seedDatabase() {
    try {
        await connectDB();

        // Baca data dari backup
        const configPath = path.join(__dirname, '../bak/config.json');
        const scheduleData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        console.log(`\n📥 Loading ${scheduleData.length} schedules from backup...`);

        // Hapus data lama (opsional)
        // await Schedule.deleteMany({});

        // Insert data baru
        // const result = await Schedule.insertMany(scheduleData);
        // console.log(`✅ Seeded ${result.length} schedules`);

        console.log('✅ Seed completed successfully');
        process.exit(0);
    } catch (err) {
        console.error('❌ Seed failed:', err);
        process.exit(1);
    }
}

seedDatabase();

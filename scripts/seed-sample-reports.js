'use strict';

// Seed 8 laporan SAQ contoh ke MongoDB lokal via jalur repository aplikasi.

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { connectDB } = require('../config/database');
const { initRepositories, reportRepo } = require('../repositories');
const JsonStoreModel = require('../models/JsonStore');

function report(id, scheduleId, date, formattedDate, materi, deskripsi, keterangan, assistants, status, author, image) {
    return {
        id, schedule_id: scheduleId, date, formattedDate,
        materi, deskripsiKegiatan: deskripsi, keterangan,
        attending_assistant_ids: assistants, status,
        imagePath: image, imageFilename: image, author,
        receivedAt: '2026-10-' + (10 + Number(id.slice(-2))).toString().padStart(2, '0') + 'T09:15:00.000Z',
    };
}

const reports = [
    report('RPT-2026-01', 'JDW-101', '2026-10-10', 'Senin, 10 Oktober 2026',
        'Pengenalan Arsitektur Komputer: representasi data, komplement dua, dan operasi bitwise.',
        'Praktikum dibuka dengan pre-test singkat lalu dilanjutkan pengerjaan modul 1; asisten menjelaskan konsep endianness dan memberi studi kasus konversi bilangan bertanda.',
        'H-101 hadir penuh; H-102 izin kegiatan kampus.', ['AST-01', 'AST-02'], 'hadir', 'AST-01', null),
    report('RPT-2026-02', 'JDW-102', '2026-10-10', 'Senin, 10 Oktober 2026',
        'Struktur Data: array, linked list, dan kompleksitas operasi dasar.',
        'Mahasiswa mengimplementasikan singly linked list dan mengukur kompleksitas akses; sesi ditutup dengan kuis singkat di akhir kelas.',
        'Seluruh mahasiswa hadir.', ['AST-03'], 'hadir', 'AST-03', 'RPT-2026-02.jpg'),
    report('RPT-2026-03', 'JDW-103', '2026-10-11', 'Selasa, 11 Oktober 2026',
        'Pemrograman Jaringan: socket TCP sederhana dan protokol handshake.',
        'Demo pembuatan server echo dengan socket TCP di Node.js dan Python; pembahasan perbedaan blocking dan non-blocking I/O disertai contoh kasus nyata pada aplikasi chat.',
        'Ruang lab diganti ke C-204 karena renovasi.', ['AST-01'], 'hadir', 'AST-01', null),
    report('RPT-2026-04', 'JDW-104', '2026-10-11', 'Selasa, 11 Oktober 2026',
        'Basis Data: normalisasi hingga bentuk 3NF dan indeks B-tree.',
        'Studi kasus normalisasi tabel laporan praktikum; mahasiswa diminta mendesain skema relasional lalu membandingkan kueri dengan dan tanpa indeks pada dataset 100 ribu baris.',
        'H-201 dan H-215 terlambat 10 menit karena kesalahan jadwal.', ['AST-02', 'AST-04'], 'hadir', 'AST-02', null),
    report('RPT-2026-05', 'JDW-105', '2026-10-12', 'Rabu, 12 Oktober 2026',
        null, null,
        'Libur sesuai kalender akademik.', [], 'libur', 'AST-05', null),
    report('RPT-2026-06', 'JDW-106', '2026-10-12', 'Rabu, 12 Oktober 2026',
        'Sistem Operasi: penjadwalan proses round-robin dan prioritas.',
        'Simulasi penjadwalan dengan quantum berbeda menggunakan tools buatan asisten; dibahas efek starvation dan aging serta perbandingan waktu tunggu rata-rata tiap skenario.',
        'Kelas diperpendek 30 menit karena sesi konsultasi skripsi paralel.', ['AST-05'], 'hadir', 'AST-05', null),
    report('RPT-2026-07', 'JDW-107', '2026-10-13', 'Kamis, 13 Oktober 2026',
        'Kecerdasan Buatan: pencarian DFS/BFS pada graf kota dan heuristik A*.',
        'Implementasi pathfinding pada peta kampus sederhana; mahasiswa membandingkan jumlah node yang dieksplorasi antara BFS dan A* dengan dua fungsi heuristik berbeda lalu mendiskusikan kualitas solusi versus biaya komputasi.',
        'Ada tamu dari lab eksternal yang ikut mengamati.', ['AST-01', 'AST-03'], 'hadir', 'AST-01', 'RPT-2026-07.jpg'),
    report('RPT-2026-08', 'JDW-108', '2026-10-13', 'Kamis, 13 Oktober 2026',
        'Rekayasa Perangkat Lunak: code review, unit test, dan continuous integration.',
        'Sesi pair-review kode tugas modul sebelumnya; diperkenalkan kerangka CI sederhana yang menjalankan unit test otomatis pada setiap push dan menampilkan badge status pada README repositori.',
        'Tiga kelompok belum lulus review, diberi kesempatan perbaikan pekan depan.', ['AST-02'], 'hadir', 'AST-02', null),
];

(async () => {
    await connectDB();
    await initRepositories();

    const existing = reportRepo.read();
    if (Array.isArray(existing) && existing.length > 0) {
        console.log('PERINGATAN: reports sudah berisi', existing.length, 'laporan — seed dibatalkan agar tidak menimpa data.');
        process.exit(1);
    }

    reportRepo.write(reports);

    // Persist MongoJsonRepository bersifat async (janji internal); tunggu hingga
    // benar-benar tersimpan di MongoDB sebelum keluar.
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const doc = await JsonStoreModel.findOne({ key: 'reports' }).lean();
        if (doc && Array.isArray(doc.value) && doc.value.length === reports.length) {
            console.log('Seed sukses:', doc.value.length, 'laporan tersimpan di MongoDB.');
            await require('mongoose').disconnect();
            process.exit(0);
        }
    }
    console.error('Seed gagal terverifikasi dalam 10 detik.');
    process.exit(1);
})().catch((error) => {
    console.error('Seed gagal:', error.message);
    process.exit(1);
});

'use strict';

/**
 * scripts/export.js
 *
 * CLI runner untuk export praktikum SAQ dari D:\V3.
 *
 * Penggunaan:
 *   node scripts/export.js                     # Export semua (DOCX, Berita Acara, Rekap)
 *   node scripts/export.js --rekap             # Hanya Rekap Kehadiran (XLSX)
 *   node scripts/export.js --berita-acara      # Hanya Berita Acara (XLSX)
 *   node scripts/export.js --docx              # Hanya Laporan Harian (DOCX)
 *   node scripts/export.js --month=4           # Rekap bulan tertentu (contoh: 4 = April)
 *   node scripts/export.js --year=2026         # Target tahun spesifik
 */

require('dotenv').config();
const path = require('path');
const { connectDB } = require('../config/database');
const { initRepositories, globalConfigRepo } = require('../repositories');
const {
    generateAllExports,
    generateAllRekapKehadiran,
    generateRekapKehadiranForMonth,
    generateAllBeritaAcara,
    generateAllDocxReports,
    buildComprehensiveListWithPlaceholders,
    getExportDirs,
} = require('../services/exportService');

async function runCli() {
    const args = process.argv.slice(2);

    let mode = 'all';
    let targetYear = null;
    let targetMonth = null;

    for (const arg of args) {
        if (arg === '--rekap') mode = 'rekap';
        else if (arg === '--berita-acara' || arg === '--ba') mode = 'berita-acara';
        else if (arg === '--docx' || arg === '--harian') mode = 'docx';
        else if (arg.startsWith('--year=')) targetYear = parseInt(arg.split('=')[1], 10);
        else if (arg.startsWith('--month=')) targetMonth = parseInt(arg.split('=')[1], 10);
        else if (arg === '--help' || arg === '-h') {
            console.log(`
SAQ Praktikum Exporter CLI
Penggunaan:
  node scripts/export.js [options]

Opsi:
  --all               Export semua dokumen (default)
  --rekap             Export Rekap Kehadiran (XLSX)
  --berita-acara      Export Berita Acara per kelas (XLSX)
  --docx              Export Laporan Harian (DOCX)
  --year=<YYYY>       Pilih tahun (contoh: --year=2026)
  --month=<1-12>      Pilih bulan tertentu untuk rekap (contoh: --month=4)
  --help, -h          Tampilkan bantuan ini
            `);
            process.exit(0);
        }
    }

    console.log('[SAQ EXPORT] Menginisialisasi koneksi database & repositori...');
    await connectDB();
    await initRepositories();

    const globalConfig = globalConfigRepo.read();
    const year = targetYear || (globalConfig?.semester || {}).year || new Date().getFullYear();
    const dirs = getExportDirs(year);

    console.log(`[SAQ EXPORT] Mode: ${mode.toUpperCase()} | Tahun: ${year}`);
    console.log(`[SAQ EXPORT] Folder output: ${dirs.baseYearDir}`);

    const startTime = Date.now();

    if (mode === 'all') {
        const result = await generateAllExports({ year });
        console.log(`\n✅ Sukses! Total file: ${result.counts.total}`);
        console.log(`   - Laporan Harian (DOCX) : ${result.counts.docx}`);
        console.log(`   - Berita Acara (XLSX)   : ${result.counts.beritaAcara}`);
        console.log(`   - Rekap Kehadiran (XLSX): ${result.counts.rekapKehadiran}`);
    } else if (mode === 'rekap') {
        if (targetMonth) {
            const firstMonth = (globalConfig?.semester?.months || [])[0] || 1;
            const targetYearCalc = (targetMonth < firstMonth) ? year + 1 : year;
            console.log(`[SAQ EXPORT] Menghasilkan Rekap Kehadiran bulan ${targetMonth} (tahun ${targetYearCalc})...`);
            const filePath = await generateRekapKehadiranForMonth(targetMonth, targetYearCalc, globalConfig, { year: targetYearCalc });
            console.log(`✅ File dibuat: ${filePath}`);
        } else {
            console.log(`[SAQ EXPORT] Menghasilkan Rekap Kehadiran semua bulan...`);
            const files = await generateAllRekapKehadiran(globalConfig, { year });
            console.log(`✅ Sukses! ${files.length} file rekap kehadiran dibuat di ${dirs.rekapDir}`);
        }
    } else if (mode === 'berita-acara') {
        console.log(`[SAQ EXPORT] Menghasilkan Berita Acara per kelas...`);
        const data = buildComprehensiveListWithPlaceholders();
        const files = await generateAllBeritaAcara(data, globalConfig, { year });
        console.log(`✅ Sukses! ${files.length} file Berita Acara dibuat di ${dirs.beritaAcaraDir}`);
    } else if (mode === 'docx') {
        console.log(`[SAQ EXPORT] Menghasilkan Laporan Harian (DOCX)...`);
        const data = buildComprehensiveListWithPlaceholders();
        const files = generateAllDocxReports(data, globalConfig, { year });
        console.log(`✅ Sukses! ${files.length} file Laporan Harian DOCX dibuat di ${dirs.laporanHarianDir}`);
    }

    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SAQ EXPORT] Waktu eksekusi: ${elapsedSeconds} detik.\n`);

    process.exit(0);
}

runCli().catch(err => {
    console.error('❌ [SAQ EXPORT] Terjadi error:', err);
    process.exit(1);
});

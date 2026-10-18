const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const ExcelJS = require('exceljs');
const { courseRepo, assistantRepo, scheduleRepo, reportRepo, globalConfigRepo } = require('../repositories');
const { getEnrichedSchedules, getEnrichedReports } = require('../services/scheduleService');
const { buildAttendanceGrid, formatJam } = require('../services/attendanceService');
const {
    generateAllExports,
    generateAllRekapKehadiran,
    generateRekapKehadiranForMonth,
    generateAllBeritaAcara,
    generateAllDocxReports,
    buildComprehensiveListWithPlaceholders,
    getExportStats,
    EXPORT_BASE_DIR,
    getExportDirs,
} = require('../services/exportService');
const { asyncHandler } = require('./_helpers');

const router = Router();

// Halaman pilihan rekap
router.get('/', asyncHandler(async (req, res) => {
    const stats = {
        totalCourses:    courseRepo.read().length,
        totalAssistants: assistantRepo.read().length,
        totalSchedules:  scheduleRepo.read().length,
        totalReports:    reportRepo.read().length,
    };
    res.render('rekap-pilihan', {
        title:      'Rekap Bendahara - Pilih Jenis Rekap',
        stats,
        activePage: 'rekap',
    });
}));

const MONTH_NAMES_ID = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/**
 * Helper untuk menghitung data rekap SKS asisten dengan filter bulan & tahun.
 */
function getRekapAsistenData(monthQuery, yearQuery) {
    const globalConfig = globalConfigRepo.read();
    const now = new Date();

    const isAllMonths = monthQuery === 'all';
    const selectedMonth = isAllMonths
        ? 'all'
        : (parseInt(monthQuery, 10) || (now.getMonth() + 1));
    const selectedYear = parseInt(yearQuery, 10) || (globalConfig?.semester || {}).year || now.getFullYear();

    const assistants = assistantRepo.read();
    const schedules  = getEnrichedSchedules();
    const allReports = getEnrichedReports();

    let filteredReports = allReports;
    if (!isAllMonths) {
        const monthNum = parseInt(selectedMonth, 10);
        const monthPrefix = `${selectedYear}-${String(monthNum).padStart(2, '0')}`;
        filteredReports = allReports.filter(r => {
            if (!r.date) return false;
            if (r.date.startsWith(monthPrefix)) return true;
            const d = new Date(r.date);
            return !isNaN(d) && (d.getMonth() + 1) === monthNum && d.getFullYear() === selectedYear;
        });
    }

    const rekapAsisten = assistants.map(assistant => {
        const assignedSchedules = schedules.filter(s =>
            s.assistant_ids.includes(assistant.id) || s.pj_assistant_id === assistant.id
        );
        const attendedReports = filteredReports.filter(r =>
            r.attending_assistant_ids?.includes(assistant.id)
        );

        let totalSKS       = 0;
        const detailKehadiran = [];

        attendedReports.forEach(report => {
            const courseSks = report.course?.sks ?? report.course?.credits ?? 0;
            if (courseSks > 0) {
                totalSKS += courseSks;
                detailKehadiran.push({
                    tanggal:          report.date,
                    tanggalFormatted: report.formattedDate ||
                        new Date(report.date).toLocaleDateString('id-ID'),
                    courseCode:       report.course?.code || '-',
                    courseName:       report.course?.name || '-',
                    sks:              courseSks,
                    kelas:            report.schedule?.class ?? 'N/A',
                    status:           report.status,
                });
            }
        });

        const isPjSchedules    = schedules.filter(s => s.pj_assistant_id === assistant.id);
        const regularSchedules = schedules.filter(s =>
            s.assistant_ids.includes(assistant.id) && s.pj_assistant_id !== assistant.id
        );

        return {
            ...assistant,
            totalSKS,
            totalKehadiran:         attendedReports.length,
            assignedSchedules:      assignedSchedules.length,
            isPjCount:              isPjSchedules.length,
            regularAssignmentCount: regularSchedules.length,
            detailKehadiran:        detailKehadiran.sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal)),
            averageSKSPerReport:    attendedReports.length > 0
                ? (totalSKS / attendedReports.length).toFixed(2) : 0,
        };
    }).sort((a, b) => b.totalSKS - a.totalSKS);

    const periodLabel = isAllMonths
        ? `Semua Bulan (Tahun ${selectedYear})`
        : `${MONTH_NAMES_ID[selectedMonth - 1] || 'Bulan ' + selectedMonth} ${selectedYear}`;

    let prevMonth = null;
    let prevYear = selectedYear;
    let nextMonth = null;
    let nextYear = selectedYear;
    if (!isAllMonths) {
        prevMonth = selectedMonth > 1 ? selectedMonth - 1 : 12;
        prevYear  = selectedMonth > 1 ? selectedYear      : selectedYear - 1;
        nextMonth = selectedMonth < 12 ? selectedMonth + 1 : 1;
        nextYear  = selectedMonth < 12 ? selectedYear      : selectedYear + 1;
    }

    return {
        assistants,
        rekapAsisten,
        selectedMonth,
        selectedYear,
        isAllMonths,
        periodLabel,
        prevMonth,
        prevYear,
        nextMonth,
        nextYear,
        monthOptions: MONTH_NAMES_ID.map((name, idx) => ({ value: idx + 1, label: name })),
    };
}

// Rekap SKS & Kehadiran Asisten (dengan filter bulan & tahun)
router.get('/asisten', asyncHandler(async (req, res) => {
    const data = getRekapAsistenData(req.query.month, req.query.year);

    res.render('rekap-asisten', {
        title:                 `Rekap SKS Asisten — ${data.periodLabel}`,
        rekapAsisten:          data.rekapAsisten,
        totalAsisten:          data.assistants.length,
        totalSKSKeseluruhan:   data.rekapAsisten.reduce((sum, a) => sum + a.totalSKS, 0),
        activePage:            'rekap',
        selectedMonth:         data.selectedMonth,
        selectedYear:          data.selectedYear,
        isAllMonths:           data.isAllMonths,
        periodLabel:           data.periodLabel,
        prevMonth:             data.prevMonth,
        prevYear:              data.prevYear,
        nextMonth:             data.nextMonth,
        nextYear:              data.nextYear,
        monthOptions:          data.monthOptions,
    });
}));

// Export XLSX Rekap SKS Asisten
router.get('/asisten/export-xlsx', asyncHandler(async (req, res) => {
    const data = getRekapAsistenData(req.query.month, req.query.year);
    const { rekapAsisten, periodLabel, selectedMonth, selectedYear, isAllMonths } = data;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sistem Praktikum SAQ';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Rekap SKS Asisten', {
        pageSetup: { paperSize: 9, orientation: 'portrait' },
    });

    // Judul & Periode
    sheet.mergeCells('A1:G1');
    sheet.getCell('A1').value = 'REKAP SKS & KEHADIRAN ASISTEN LABORATORIUM';
    sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
    sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

    sheet.mergeCells('A2:G2');
    sheet.getCell('A2').value = `Periode: ${periodLabel}`;
    sheet.getCell('A2').font = { bold: true, size: 11, color: { argb: 'FF555555' } };
    sheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };

    sheet.addRow([]); // Baris kosong pemisah

    // Header Tabel
    const headerRow = sheet.addRow([
        'Ranking',
        'Nama Asisten',
        'Panggilan / Inisial',
        'Total SKS',
        'Total Kehadiran',
        'Rata-rata SKS',
        'Status Penugasan',
    ]);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 24;
    headerRow.eachCell((cell) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1E3A5F' },
        };
        cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' },
        };
    });

    // Data Baris
    rekapAsisten.forEach((asisten, index) => {
        const row = sheet.addRow([
            index + 1,
            asisten.nama_asisten,
            asisten.panggilan || asisten.nama_panjang || '-',
            asisten.totalSKS,
            asisten.totalKehadiran,
            asisten.averageSKSPerReport,
            `${asisten.isPjCount} PJ / ${asisten.regularAssignmentCount} Reguler`,
        ]);

        row.height = 20;
        row.alignment = { vertical: 'middle' };
        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(4).alignment = { horizontal: 'center' };
        row.getCell(5).alignment = { horizontal: 'center' };
        row.getCell(6).alignment = { horizontal: 'center' };
        row.getCell(7).alignment = { horizontal: 'center' };

        row.eachCell((cell) => {
            cell.border = {
                top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
                right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            };
        });
    });

    // Baris Total
    const totalSKSKeseluruhan = rekapAsisten.reduce((sum, a) => sum + a.totalSKS, 0);
    const totalKehadiranKeseluruhan = rekapAsisten.reduce((sum, a) => sum + a.totalKehadiran, 0);
    const totalRow = sheet.addRow([
        '',
        'TOTAL KESELURUHAN',
        '',
        totalSKSKeseluruhan,
        totalKehadiranKeseluruhan,
        '',
        '',
    ]);
    totalRow.height = 22;
    totalRow.font = { bold: true };
    totalRow.alignment = { vertical: 'middle' };
    totalRow.getCell(2).font = { bold: true };
    totalRow.getCell(4).alignment = { horizontal: 'center' };
    totalRow.getCell(5).alignment = { horizontal: 'center' };
    totalRow.eachCell((cell) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF1F5F9' },
        };
        cell.border = {
            top: { style: 'medium' },
            left: { style: 'thin' },
            bottom: { style: 'medium' },
            right: { style: 'thin' },
        };
    });

    // Lebar Kolom
    sheet.getColumn(1).width = 10;
    sheet.getColumn(2).width = 30;
    sheet.getColumn(3).width = 25;
    sheet.getColumn(4).width = 14;
    sheet.getColumn(5).width = 16;
    sheet.getColumn(6).width = 16;
    sheet.getColumn(7).width = 25;

    const fileSuffix = isAllMonths ? `Semua_Bulan_${selectedYear}` : `${selectedMonth}_${selectedYear}`;
    const filename = `Rekap_SKS_Asisten_${fileSuffix}.xlsx`;

    res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`
    );

    await workbook.xlsx.write(res);
    res.end();
}));

// Rekap Laporan Per Kelas
router.get('/kelas', asyncHandler(async (req, res) => {
    const schedules = getEnrichedSchedules();
    const reports   = getEnrichedReports();

    const rekapKelas = schedules.map(schedule => {
        const classReports = reports.filter(r => r.schedule_id === schedule.id);
        const sorted       = [...classReports].sort((a, b) => new Date(b.date) - new Date(a.date));

        const statusBreakdown = {
            hadir:           classReports.filter(r => r.status === 'hadir').length,
            libur:           classReports.filter(r => r.status === 'libur').length,
            pengganti:       classReports.filter(r => r.status === 'pengganti').length,
            belumAdaLaporan: classReports.filter(r => r.status === 'belum ada laporan').length,
        };

        const pertemuanEfektif  = statusBreakdown.hadir + statusBreakdown.pengganti;
        const totalPertemuan    = classReports.length;
        const latestReport      = sorted[0] ?? null;

        const detailLaporan = sorted.map(r => ({
            tanggal:          r.date,
            tanggalFormatted: r.formattedDate || new Date(r.date).toLocaleDateString('id-ID'),
            status:           r.status,
            materi:           r.materi        || '-',
            jumlahAsisten:    r.attending_assistant_ids?.length ?? 0,
            keterangan:       r.keterangan    || '-',
        }));

        return {
            ...schedule,
            totalLaporan:         totalPertemuan,
            pertemuanEfektif,
            tingkatKehadiran:     totalPertemuan > 0
                ? ((pertemuanEfektif / totalPertemuan) * 100).toFixed(1) : 0,
            statusBreakdown,
            latestReportDate:     latestReport?.date ?? null,
            latestReportFormatted: latestReport
                ? (latestReport.formattedDate || new Date(latestReport.date).toLocaleDateString('id-ID'))
                : 'Belum ada laporan',
            detailLaporan,
            totalSKSGenerated:    totalPertemuan * (schedule.course?.sks ?? schedule.course?.credits ?? 0),
        };
    }).sort((a, b) => b.totalLaporan - a.totalLaporan);

    res.render('rekap-kelas', {
        title:                   'Rekap Laporan Kelas',
        rekapKelas,
        totalKelas:              schedules.length,
        totalLaporanKeseluruhan: rekapKelas.reduce((sum, k) => sum + k.totalLaporan, 0),
        activePage:              'rekap',
    });
}));

// Rekap Kehadiran Bulanan (spreadsheet-style grid)
router.get('/kehadiran', asyncHandler(async (req, res) => {
    const now = new Date();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    const year = parseInt(req.query.year) || now.getFullYear();
    const viewType = req.query.viewType || 'angka';

    const gridData = buildAttendanceGrid(month, year);
    const exportStats = getExportStats(year);

    // Navigasi bulan sebelumnya / berikutnya
    const prevMonth = month > 1  ? month - 1 : 12;
    const prevYear  = month > 1  ? year      : year - 1;
    const nextMonth = month < 12 ? month + 1 : 1;
    const nextYear  = month < 12 ? year      : year + 1;

    res.render('rekap-kehadiran', {
        title:       `Rekap Kehadiran — ${gridData.monthInfo.monthName} ${year}`,
        activePage:  'rekap',
        gridData,
        formatJam,
        currentMonth: month,
        currentYear:  year,
        prevMonth, prevYear,
        nextMonth, nextYear,
        exportStats,
        exportSuccess: req.query.exportSuccess === 'true',
        exportedType:  req.query.exported || null,
        viewType,
    });
}));

// Trigger Export Semua Dokumen (DOCX, Berita Acara, Rekap)
router.get('/export-all', asyncHandler(async (req, res) => {
    const globalConfig = globalConfigRepo.read();
    const year = parseInt(req.query.year) || (globalConfig?.semester || {}).year || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

    await generateAllExports({ year });

    res.redirect(`/rekap/kehadiran?month=${month}&year=${year}&exportSuccess=true&exported=all`);
}));

// Trigger Export XLSX Rekap Kehadiran (Semua bulan di semester)
router.get('/export-xlsx', asyncHandler(async (req, res) => {
    const globalConfig = globalConfigRepo.read();
    const year = parseInt(req.query.year) || (globalConfig?.semester || {}).year || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const viewType = req.query.viewType || 'angka';

    await generateAllRekapKehadiran(globalConfig, { year, viewType });

    res.redirect(`/rekap/kehadiran?month=${month}&year=${year}&exportSuccess=true&exported=rekap&viewType=${viewType}`);
}));

// Trigger Export XLSX Rekap Kehadiran untuk Bulan Ini saja
router.get('/export-month-xlsx', asyncHandler(async (req, res) => {
    const globalConfig = globalConfigRepo.read();
    const now = new Date();
    const month = parseInt(req.query.month) || (now.getMonth() + 1);
    const baseYear = parseInt(req.query.year) || (globalConfig?.semester || {}).year || now.getFullYear();
    const firstMonth = (globalConfig?.semester?.months || [])[0] || 1;
    const year = (month < firstMonth) ? baseYear + 1 : baseYear;
    const viewType = req.query.viewType || 'angka';

    await generateRekapKehadiranForMonth(month, year, globalConfig, { year, viewType });

    res.redirect(`/rekap/kehadiran?month=${month}&year=${year}&exportSuccess=true&exported=month&viewType=${viewType}`);
}));

// Trigger Export Berita Acara (Semua kelas praktikum)
router.get('/export-berita-acara', asyncHandler(async (req, res) => {
    const globalConfig = globalConfigRepo.read();
    const year = parseInt(req.query.year) || (globalConfig?.semester || {}).year || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

    const comprehensiveData = buildComprehensiveListWithPlaceholders();
    await generateAllBeritaAcara(comprehensiveData, globalConfig, { year });

    res.redirect(`/rekap/kehadiran?month=${month}&year=${year}&exportSuccess=true&exported=berita_acara`);
}));

// Trigger Export Laporan Harian DOCX
router.get('/export-laporan-harian', asyncHandler(async (req, res) => {
    const globalConfig = globalConfigRepo.read();
    const year = parseInt(req.query.year) || (globalConfig?.semester || {}).year || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

    const comprehensiveData = buildComprehensiveListWithPlaceholders();
    generateAllDocxReports(comprehensiveData, globalConfig, { year });

    res.redirect(`/rekap/kehadiran?month=${month}&year=${year}&exportSuccess=true&exported=laporan_harian`);
}));

// Download ZIP berisi semua folder di Export/[year] (atau D:\V3\Export)
router.get('/download-exports-zip', asyncHandler(async (req, res) => {
    const globalConfig = globalConfigRepo.read();
    const year = parseInt(req.query.year) || (globalConfig?.semester || {}).year || new Date().getFullYear();
    const dirs = getExportDirs(year);
    const targetDir = fs.existsSync(dirs.baseYearDir) ? dirs.baseYearDir : EXPORT_BASE_DIR;

    if (!fs.existsSync(targetDir)) {
        return res.status(404).send('Folder export belum tersedia. Silakan jalankan export terlebih dahulu.');
    }

    const hasAnyEntry = fs.readdirSync(targetDir).some((name) => !name.startsWith('.'));
    if (!hasAnyEntry) {
        return res.status(404).send('Tidak ada file export untuk di-zip.');
    }

    const zipFileName = `SAQ_Export_${year}_${new Date().toISOString().slice(0, 10)}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.attachment(zipFileName);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
        console.error('[ZIP] Error:', err);
    });

    archive.pipe(res);

    const addDir = (dirPath, rootFolder) => {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;

            const fullPath = path.join(dirPath, entry.name);
            const relPath  = path.relative(rootFolder, fullPath).replace(/\\/g, '/');

            if (entry.isDirectory()) {
                addDir(fullPath, rootFolder);
            } else if (entry.isFile()) {
                archive.file(fullPath, { name: relPath });
            }
        }
    };

    addDir(targetDir, targetDir);

    await new Promise((resolve, reject) => {
        archive.on('error', reject);
        res.on('close', resolve);
        res.on('finish', resolve);
        archive.finalize().catch(reject);
    });
}));

module.exports = router;

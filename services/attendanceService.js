'use strict';

const {
    scheduleRepo, courseRepo, assistantRepo, reportRepo,
} = require('../repositories');

// =============================================================================
// == UTILITAS ==
// =============================================================================

const DAY_NAMES_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTH_NAMES_ID = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/**
 * Konversi SKS ke jam.
 * Rumus: 1 SKS = 50 menit → jam = (sks * 50) / 60
 * @param {number} sks
 * @returns {number} jam (2 desimal)
 */
function sksToJam(sks) {
    if (!sks || sks <= 0) return 0;
    return Math.round(((sks * 50) / 60) * 100) / 100;
}

/**
 * Format angka jam ke string 2 desimal.
 * Contoh: 2.5 → "2.50", 1.6667 → "1.67"
 */
function formatJam(jam) {
    if (!jam || jam <= 0) return '';
    return jam.toFixed(2);
}

/**
 * Mendapatkan nama bulan dalam Bahasa Indonesia (0-indexed).
 */
function getMonthName(monthIndex) {
    return MONTH_NAMES_ID[monthIndex] || '';
}

/**
 * Mendapatkan nama hari dalam Bahasa Indonesia dari Date.getDay().
 */
function getDayName(dayOfWeek) {
    return DAY_NAMES_ID[dayOfWeek] || '';
}

// =============================================================================
// == INFO HARI DALAM BULAN ==
// =============================================================================

/**
 * Generate informasi setiap hari dalam satu bulan.
 * @param {number} year  - Tahun (contoh: 2026)
 * @param {number} month - Bulan 1-based (contoh: 3 = Maret)
 * @returns {object[]} Array of { day, date (ISO), dayOfWeek, dayName, isSunday }
 */
function getMonthDaysInfo(year, month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const days = [];

    for (let d = 1; d <= daysInMonth; d++) {
        const dateObj = new Date(year, month - 1, d);
        const dayOfWeek = dateObj.getDay();
        const mm = String(month).padStart(2, '0');
        const dd = String(d).padStart(2, '0');

        days.push({
            day: d,
            date: `${year}-${mm}-${dd}`,
            dayOfWeek,
            dayName: getDayName(dayOfWeek),
            isSunday: dayOfWeek === 0,
        });
    }

    return days;
}

// =============================================================================
// == STATUS KEHADIRAN ==
// =============================================================================

/**
 * Status cell constants.
 * Dipakai untuk color coding di view dan bisa di-reuse oleh rekap/exporter.
 */
const CELL_STATUS = {
    EMPTY:       'empty',       // Tidak ada jadwal & tidak ada laporan
    NORMAL:      'normal',      // Terjadwal + hadir (sesuai jadwal)
    TAMBAHAN:    'tambahan',    // TIDAK terjadwal tapi hadir (menggantikan)
    DIGANTI:     'diganti',     // Terjadwal tapi TIDAK hadir (digantikan)
    PENGGANTI:   'pengganti',   // Kelas pengganti
    SUNDAY:      'sunday',      // Hari Minggu
    LIBUR:       'libur',       // Libur Nasional
};

// =============================================================================
// == GRID BUILDER (FUNGSI UTAMA) ==
// =============================================================================

/**
 * Bangun data grid kehadiran bulanan untuk semua asisten.
 *
 * Struktur kembalian per asisten:
 * {
 *   id, nama, nim,
 *   mataKuliahRows: [{          ← SATU ROW PER MATA KULIAH
 *     scheduleId, name, kelas,
 *     sks, jam, day,
 *     cells: { "YYYY-MM-DD": { jam, status } },
 *     totalHari,                ← total hari hadir UNTUK MATKUL INI
 *     isTambahan,
 *   }],
 *   totalJam,                   ← total jam semua matkul (untuk rowspan di kolom TOTAL JAM)
 *   totalHariKehadiran,         ← grand total hari semua matkul asisten ini
 * }
 */
function buildAttendanceGrid(month, year) {
    // 1. Load semua data
    const assistants = assistantRepo.read();
    const schedules  = scheduleRepo.read();
    const courses    = courseRepo.read();
    const reports    = reportRepo.read();

    // Lookup maps
    const courseMap = Object.fromEntries(courses.map(c => [c.id, c]));

    // 2. Info bulan
    const monthDays = getMonthDaysInfo(year, month);

    // 3. Map hari Indonesia ke dayOfWeek (JS: 0=Minggu)
    const dayNameToWeekday = {
        'Senin': 1, 'Selasa': 2, 'Rabu': 3,
        'Kamis': 4, 'Jumat': 5, 'Sabtu': 6, 'Minggu': 0,
    };

    // 4. Filter dan lookup laporan bulan ini
    const monthPrefix  = `${year}-${String(month).padStart(2, '0')}`;
    const monthReports = reports.filter(r => r.date && r.date.startsWith(monthPrefix));

    const reportLookup = {}; // key: "scheduleId__date" → report
    for (const report of monthReports) {
        reportLookup[`${report.schedule_id}__${report.date}`] = report;
    }

    // Helper: build empty cells array
    function emptyMonthCells() {
        const cells = {};
        for (const d of monthDays) {
            cells[d.date] = { jam: 0, status: d.isSunday ? CELL_STATUS.SUNDAY : CELL_STATUS.EMPTY };
        }
        return cells;
    }

    // 5. Hitung per asisten
    const assistantRows = assistants.map(assistant => {
        // Semua jadwal yang melibatkan asisten ini
        const assignedSchedules = schedules.filter(s =>
            s.pj_assistant_id === assistant.id ||
            (s.assistant_ids || []).includes(assistant.id)
        );
        const assignedSchedIds = new Set(assignedSchedules.map(s => s.id));

        // ------------------------------------------------------------------
        // A) Baris per mata kuliah yang terjadwal
        // ------------------------------------------------------------------
        const mkRows = assignedSchedules.map(sched => {
            const course = courseMap[sched.course_id] || {};
            const courseSks = course.sks ?? course.credits ?? 0;
            const mkJam  = sksToJam(courseSks);
            const schedWeekday = dayNameToWeekday[sched.day];
            const cells  = emptyMonthCells();
            let totalHari = 0;

            for (const dayInfo of monthDays) {
                if (dayInfo.isSunday) continue; // sudah SUNDAY dari emptyMonthCells

                const report = reportLookup[`${sched.id}__${dayInfo.date}`];
                if (report) {
                    const attending = report.attending_assistant_ids || [];
                    if (attending.includes(assistant.id)) {
                        cells[dayInfo.date] = {
                            jam:    mkJam,
                            status: report.status === 'pengganti' ? CELL_STATUS.PENGGANTI : CELL_STATUS.NORMAL,
                        };
                        totalHari++;
                    } else {
                        // Laporan ada, tapi asisten tidak hadir → digantikan
                        cells[dayInfo.date] = { jam: 0, status: CELL_STATUS.DIGANTI };
                    }
                    continue;
                }

                // Hari ini bukan hari jadwal matkul ini → tetap EMPTY/skip
                if (dayInfo.dayOfWeek !== schedWeekday) continue;
            }

            return {
                scheduleId:  sched.id,
                name:        course.name || 'N/A',
                kelas:       sched.class,
                sks:         courseSks,
                jam:         mkJam,
                day:         sched.day,
                cells,
                totalHari,
                isTambahan:  false,
            };
        });

        // ------------------------------------------------------------------
        // B) Baris tambahan: asisten hadir di kelas yang BUKAN miliknya
        // ------------------------------------------------------------------
        const tambahanMap = {}; // scheduleId → row

        for (const dayInfo of monthDays) {
            if (dayInfo.isSunday) continue;
            for (const report of monthReports.filter(r => r.date === dayInfo.date)) {
                if (assignedSchedIds.has(report.schedule_id)) continue;
                const attending = report.attending_assistant_ids || [];
                if (!attending.includes(assistant.id)) continue;

                const sched  = schedules.find(s => s.id === report.schedule_id);
                if (!sched) continue;
                const course = courseMap[sched.course_id] || {};
                const courseSks = course.sks ?? course.credits ?? 0;
                const jam    = sksToJam(courseSks);

                if (!tambahanMap[sched.id]) {
                    tambahanMap[sched.id] = {
                        scheduleId: sched.id,
                        name:       (course.name || 'N/A'),
                        kelas:      sched.class,
                        sks:        courseSks,
                        jam,
                        day:        sched.day,
                        cells:      emptyMonthCells(),
                        totalHari:  0,
                        isTambahan: true,
                    };
                }

                tambahanMap[sched.id].cells[dayInfo.date] = { jam, status: CELL_STATUS.TAMBAHAN };
                tambahanMap[sched.id].totalHari++;
            }
        }

        const allMkRows = [...mkRows, ...Object.values(tambahanMap)];

        // Total jam  = jumlah jam dari semua baris matkul
        const totalJam = Math.round(
            allMkRows.reduce((sum, row) =>
                sum + Object.values(row.cells).reduce((s, c) => s + (c.jam || 0), 0)
            , 0) * 100
        ) / 100;

        const totalHariKehadiran = allMkRows.reduce((sum, row) => sum + row.totalHari, 0);

        return {
            id:               assistant.id,
            nama:             assistant.nama_panjang || assistant.nama_asisten,
            nim:              assistant.NIM || '-',
            ttd_image:        assistant.ttd_image || '',
            mataKuliahRows:   allMkRows,
            totalJam,
            totalHariKehadiran,
        };
    });

    // 6. Grand totals
    const grandTotalHari = assistantRows.reduce((sum, a) => sum + a.totalHariKehadiran, 0);
    const grandTotalJam  = Math.round(
        assistantRows.reduce((sum, a) => sum + a.totalJam, 0) * 100
    ) / 100;

    return {
        monthInfo: {
            month,
            year,
            monthName:   getMonthName(month - 1),
            daysInMonth: monthDays.length,
            days:        monthDays,
        },
        assistants: assistantRows,
        grandTotalHari,
        grandTotalJam,
    };
}

// =============================================================================
// == EXPORTS ==
// =============================================================================

module.exports = {
    // Utilities (reusable)
    sksToJam,
    formatJam,
    getMonthName,
    getDayName,
    getMonthDaysInfo,

    // Constants
    CELL_STATUS,
    DAY_NAMES_ID,
    MONTH_NAMES_ID,

    // Main function
    buildAttendanceGrid,
};

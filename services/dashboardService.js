/**
 * Dashboard Analytics Service
 * Memisahkan semua kalkulasi statistik dari route handler.
 */

// ─── Week Helpers ──────────────────────────────────────────────────────────────

function _getWeekBounds() {
    const now   = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    return { start, end };
}

function _filterByWeek(reports, start, end) {
    return reports.filter(r => {
        const d = new Date(r.date);
        return d >= start && d <= end;
    });
}

// ─── Exported Functions ────────────────────────────────────────────────────────

/**
 * Ambil semua laporan di minggu berjalan.
 */
function getCurrentWeekReports(reports) {
    const { start, end } = _getWeekBounds();
    return _filterByWeek(reports, start, end);
}

/**
 * Statistik kelengkapan laporan minggu ini.
 */
function getThisWeekStats(schedules, reports) {
    const { start, end } = _getWeekBounds();
    const weekReports     = _filterByWeek(reports, start, end);
    const reportedIds     = [...new Set(weekReports.map(r => r.schedule_id))];
    const total           = schedules.length;
    const reported        = reportedIds.length;

    return {
        totalSchedules:     total,
        reportedSchedules:  reported,
        pendingSchedules:   total - reported,
        completionRate:     total > 0 ? Math.round((reported / total) * 100) : 0,
        reportedScheduleIds: reportedIds,
    };
}

/**
 * Jadwal yang belum dilaporkan minggu ini, dilengkapi dengan data relasi.
 */
function getPendingSchedulesThisWeek(schedules, reports, courses, lecturers, assistants) {
    const { start, end }  = _getWeekBounds();
    const weekReports     = _filterByWeek(reports, start, end);
    const reportedIds     = new Set(weekReports.map(r => r.schedule_id));

    const DAY_MAP = {
        Minggu: 0, Senin: 1, Selasa: 2, Rabu: 3,
        Kamis: 4, Jumat: 5, Sabtu: 6,
    };

    function dateForDay(dayName) {
        const idx = DAY_MAP[dayName];
        if (idx === undefined) return null;
        const d = new Date(start);
        d.setDate(start.getDate() + idx);
        return d;
    }

    const enriched = schedules
        .filter(s => !reportedIds.has(s.id))
        .map(schedule => {
            const course    = courses.find(c => c.id === schedule.course_id) ?? null;
            const lecturer  = lecturers.find(l => l.id === schedule.lecturer_id) ?? null;
            const pjAssistant = assistants.find(a => a.id === schedule.pj_assistant_id) ?? null;
            const scheduleAssistants = assistants.filter(a => schedule.assistant_ids.includes(a.id));
            const scheduleDate = dateForDay(schedule.day);

            const expectedDate = scheduleDate
                ? `${scheduleDate.getFullYear()}-${String(scheduleDate.getMonth() + 1).padStart(2, '0')}-${String(scheduleDate.getDate()).padStart(2, '0')}`
                : null;

            return {
                ...schedule,
                course, lecturer, pjAssistant,
                assistants: scheduleAssistants,
                scheduleDate,
                formattedDate: scheduleDate
                    ? scheduleDate.toLocaleDateString('id-ID', {
                        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                    })
                    : schedule.day,
                expectedDate,
            };
        });

    return {
        schedules: enriched,
        weekRange: `${start.toLocaleDateString('id-ID', { day: 'numeric', month: 'long' })} - ${end.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}`,
    };
}

/**
 * Ringkasan jadwal per kelas dengan info dosen dan mata kuliah.
 */
function getScheduleAnalysis(schedules, courses, lecturers) {
    return schedules.map(schedule => {
        const course   = courses.find(c => c.id === schedule.course_id);
        const lecturer = lecturers.find(l => l.id === schedule.lecturer_id);
        return {
            id:             schedule.id,
            courseName:     course?.name    ?? 'Unknown Course',
            courseCode:     course?.code    ?? 'N/A',
            lecturerName:   lecturer?.name  ?? 'Unknown Lecturer',
            class:          schedule.class,
            day:            schedule.day,
            time:           schedule.time,
            assistantCount: schedule.assistant_ids.length,
        };
    });
}

/**
 * Performa kehadiran masing-masing asisten.
 */
function getAssistantPerformance(assistants, reports, schedules) {
    return assistants
        .map(assistant => {
            const attended = reports.filter(
                r => r.attending_assistant_ids?.includes(assistant.id)
            );
            const assigned = schedules.filter(
                s => s.assistant_ids.includes(assistant.id) || s.pj_assistant_id === assistant.id
            );
            const isPjCount = schedules.filter(s => s.pj_assistant_id === assistant.id).length;

            return {
                id:             assistant.id,
                nama:           assistant.nama_asisten,
                namaPanjang:    assistant.nama_panjang,
                panggilan:      assistant.panggilan,
                attendedCount:  attended.length,
                assignedCount:  assigned.length,
                isPjCount,
                attendanceRate: assigned.length > 0
                    ? Math.round((attended.length / assigned.length) * 100)
                    : 0,
            };
        })
        .sort((a, b) => b.attendedCount - a.attendedCount);
}

/**
 * Statistik jumlah laporan per bulan.
 */
function getMonthlyReportStats(reports) {
    const monthly = {};

    reports.forEach(report => {
        const date     = new Date(report.date);
        const key      = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

        if (!monthly[key]) {
            monthly[key] = { month: key, count: 0, hadir: 0, tidakHadir: 0 };
        }
        monthly[key].count++;
        if (report.status === 'hadir') {
            monthly[key].hadir++;
        } else {
            monthly[key].tidakHadir++;
        }
    });

    return Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Map tanggal -> laporan untuk tampilan kalender.
 */
function getCalendarData(reports) {
    return reports.reduce((acc, report) => {
        (acc[report.date] ??= []).push(report);
        return acc;
    }, {});
}

module.exports = {
    getCurrentWeekReports,
    getThisWeekStats,
    getPendingSchedulesThisWeek,
    getScheduleAnalysis,
    getAssistantPerformance,
    getMonthlyReportStats,
    getCalendarData,
};

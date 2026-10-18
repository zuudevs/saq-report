const {
    scheduleRepo, courseRepo, lecturerRepo, assistantRepo, reportRepo,
} = require('../repositories');

/**
 * Memperkaya satu schedule dengan data relasi dari file JSON lain.
 */
function enrichSchedule(schedule, { courses, lecturers, assistants }) {
    return {
        ...schedule,
        course:     courses.find(c => c.id === schedule.course_id)      ?? null,
        lecturer:   lecturers.find(l => l.id === schedule.lecturer_id)  ?? null,
        pjAssistant: assistants.find(a => a.id === schedule.pj_assistant_id) ?? null,
        assistants: assistants.filter(a => schedule.assistant_ids.includes(a.id)),
    };
}

/**
 * Mengembalikan semua jadwal yang sudah diperkaya dengan data relasi.
 */
function getEnrichedSchedules() {
    const schedules  = scheduleRepo.read();
    const courses    = courseRepo.read();
    const lecturers  = lecturerRepo.read();
    const assistants = assistantRepo.read();

    return schedules.map(s => enrichSchedule(s, { courses, lecturers, assistants }));
}

/**
 * Mengembalikan semua laporan yang sudah diperkaya dengan data relasi.
 */
function getEnrichedReports() {
    const reports    = reportRepo.read();
    const schedules  = scheduleRepo.read();
    const courses    = courseRepo.read();
    const lecturers  = lecturerRepo.read();
    const assistants = assistantRepo.read();

    return reports.map(report => {
        const schedule = schedules.find(s => s.id === report.schedule_id) ?? null;
        const course   = schedule ? (courses.find(c => c.id === schedule.course_id) ?? null) : null;
        const lecturer = schedule ? (lecturers.find(l => l.id === schedule.lecturer_id) ?? null) : null;
        const attendingAssistants = assistants.filter(
            a => report.attending_assistant_ids?.includes(a.id)
        );

        return { ...report, schedule, course, lecturer, attendingAssistants };
    });
}

/**
 * Mencari jadwal yang cocok berdasarkan nama/kode mata kuliah dan kelas.
 * @returns {object|null} Jadwal yang cocok, atau null jika tidak ditemukan
 */
function findScheduleMatch(mataKuliahInput, kelasInput) {
    if (!mataKuliahInput || !kelasInput) return null;

    const normMk    = mataKuliahInput.trim().toLowerCase();
    const normKelas = kelasInput.trim().toLowerCase();
    const courses   = courseRepo.read();
    const schedules = scheduleRepo.read();

    // Exact match dulu, kemudian partial match
    let matchedCourse =
        courses.find(c => c.name.trim().toLowerCase() === normMk) ||
        courses.find(c => c.code.trim().toLowerCase() === normMk);

    if (!matchedCourse) {
        const words = normMk.split(/[\s().,]+/).filter(Boolean);
        matchedCourse = courses.find(c =>
            words.every(w => c.name.trim().toLowerCase().includes(w))
        );
    }

    if (!matchedCourse) return null;

    return schedules.find(
        s => s.course_id === matchedCourse.id &&
             s.class.trim().toLowerCase() === normKelas
    ) ?? null;
}

/**
 * Generate data kalender kehadiran untuk satu jadwal di bulan tertentu.
 */
function generateAsistenCalendar(schedule, reports, month, year) {
    const DAY_MAP = {
        Minggu: 0, Senin: 1, Selasa: 2, Rabu: 3,
        Kamis: 4, Jumat: 5, Sabtu: 6,
    };

    const daysInMonth  = new Date(year, month, 0).getDate();
    const firstDay     = new Date(year, month - 1, 1).getDay();
    const scheduleDay  = DAY_MAP[schedule.day];
    const scheduleReports = reports.filter(r => r.schedule_id === schedule.id);
    const todayIso     = new Date().toISOString().split('T')[0];

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const date      = new Date(year, month - 1, d);
        const dateIso   = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const report    = scheduleReports.find(r => r.date === dateIso);

        days.push({
            day:          d,
            date:         dateIso,
            dayOfWeek:    date.getDay(),
            isScheduleDay: date.getDay() === scheduleDay,
            hasReport:    !!report,
            reportId:     report?.id ?? null,
            isPast:       date < new Date().setHours(0, 0, 0, 0),
            isToday:      dateIso === todayIso,
        });
    }

    return {
        days,
        firstDay,
        monthName: new Date(year, month - 1, 1).toLocaleDateString('id-ID', { month: 'long' }),
        year,
        schedule,
    };
}

module.exports = {
    getEnrichedSchedules,
    getEnrichedReports,
    findScheduleMatch,
    generateAsistenCalendar,
};

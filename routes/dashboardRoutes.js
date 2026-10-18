const { Router } = require('express');
const { courseRepo, lecturerRepo, assistantRepo, scheduleRepo, reportRepo, globalConfigRepo } = require('../repositories');
const {
    getCurrentWeekReports,
    getThisWeekStats,
    getPendingSchedulesThisWeek,
    getScheduleAnalysis,
    getAssistantPerformance,
    getMonthlyReportStats,
    getCalendarData,
} = require('../services/dashboardService');
const { asyncHandler } = require('./_helpers');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
    const courses    = courseRepo.read();
    const lecturers  = lecturerRepo.read();
    const assistants = assistantRepo.read();
    const schedules  = scheduleRepo.read();
    const reports    = reportRepo.read();
    const globalConfig = globalConfigRepo.read();

    const scheduleAnalysis   = getScheduleAnalysis(schedules, courses, lecturers);
    const avgAssistantsPerClass = scheduleAnalysis.length > 0
        ? Math.round(
            (scheduleAnalysis.reduce((acc, s) => acc + s.assistantCount, 0) / scheduleAnalysis.length) * 10
          ) / 10
        : 0;

    res.render('dashboard', {
        title:      'Dashboard Admin Akademik',
        activePage: 'dashboard',
        globalConfig,
        stats: {
            totalCourses:    courses.length,
            totalLecturers:  lecturers.length,
            totalAssistants: assistants.length,
            totalSchedules:  schedules.length,
            totalReports:    reports.length,
        },
        currentWeek:             getCurrentWeekReports(reports),
        thisWeekStats:           getThisWeekStats(schedules, reports),
        pendingSchedulesThisWeek: getPendingSchedulesThisWeek(schedules, reports, courses, lecturers, assistants),
        scheduleAnalysis,
        assistantPerformance:    getAssistantPerformance(assistants, reports, schedules),
        monthlyStats:            getMonthlyReportStats(reports),
        calendarData:            getCalendarData(reports),
        avgAssistantsPerClass,
    });
}));

module.exports = router;

/**
 * Entity Repositories
 * Setiap export adalah instance siap pakai.
 * Gunakan: const { assistantRepo } = require('./repositories');
 */

const MongoJsonRepository = require('./MongoJsonRepository');
const PATHS = require('../config/paths');

const assistantRepo  = new MongoJsonRepository(PATHS.CONFIG_ASISTEN, 'assistants', [], 'assistants');
const courseRepo     = new MongoJsonRepository(PATHS.COURSES,        'courses',    [], 'courses');
const lecturerRepo   = new MongoJsonRepository(PATHS.LECTURERS,      'lecturers',  [], 'lecturers');
const scheduleRepo   = new MongoJsonRepository(PATHS.SCHEDULES,      'schedules',  [], 'schedules');
const reportRepo     = new MongoJsonRepository(PATHS.REPORTS,        null,         [], 'reports');
const globalConfigRepo = new MongoJsonRepository(PATHS.CONFIG_GLOBAL, null,        {}, 'globalConfig');

module.exports = {
    assistantRepo,
    courseRepo,
    lecturerRepo,
    scheduleRepo,
    reportRepo,
    globalConfigRepo,
};

// Async init untuk memuat cache dari MongoDB sebelum request pertama.
async function initRepositories() {
    await Promise.all([
        assistantRepo.init(),
        courseRepo.init(),
        lecturerRepo.init(),
        scheduleRepo.init(),
        reportRepo.init(),
        globalConfigRepo.init(),
    ]);
}

module.exports.initRepositories = initRepositories;

const { Router } = require('express');
const { scheduleRepo, courseRepo, lecturerRepo, assistantRepo } = require('../repositories');
const { getEnrichedSchedules } = require('../services/scheduleService');
const AppError                 = require('../config/AppError');
const { asyncHandler, generateId } = require('./_helpers');

const router = Router();

// READ
router.get('/', asyncHandler(async (req, res) => {
    const schedules = getEnrichedSchedules();
    res.render('jadwal', {
        schedules,
        title:      'Manajemen Jadwal Mata Kuliah',
        activePage: 'jadwal',
    });
}));

// CREATE - Form
router.get('/add', asyncHandler(async (req, res) => {
    res.render('add-jadwal', {
        title:      'Tambah Jadwal Baru',
        courses:    courseRepo.read(),
        lecturers:  lecturerRepo.read(),
        assistants: assistantRepo.read(),
        activePage: 'jadwal',
    });
}));

// CREATE - Proses
router.post('/add', asyncHandler(async (req, res) => {
    const schedules    = scheduleRepo.read();
    const assistantIds = req.body.assistant_ids || [];

    const newSchedule = {
        id:               generateId('SCHED'),
        course_id:        req.body.course_id,
        lecturer_id:      req.body.lecturer_id,
        class:            req.body.class.toUpperCase(),
        day:              req.body.day,
        time:             req.body.time,
        pj_assistant_id:  req.body.pj_assistant_id,
        assistant_ids:    Array.isArray(assistantIds) ? assistantIds : [assistantIds],
    };
    schedules.push(newSchedule);
    scheduleRepo.write(schedules);
    res.redirect('/jadwal');
}));

// UPDATE - Form
router.get('/edit/:id', asyncHandler(async (req, res) => {
    const schedules = scheduleRepo.read();
    const schedule  = schedules.find(s => s.id === req.params.id);
    if (!schedule) throw new AppError('Jadwal tidak ditemukan', 404);

    res.render('edit-jadwal', {
        title:      'Edit Jadwal Mata Kuliah',
        schedule,
        courses:    courseRepo.read(),
        lecturers:  lecturerRepo.read(),
        assistants: assistantRepo.read(),
        activePage: 'jadwal',
    });
}));

// UPDATE - Proses
router.post('/update/:id', asyncHandler(async (req, res) => {
    const schedules    = scheduleRepo.read();
    const idx          = schedules.findIndex(s => s.id === req.params.id);
    if (idx === -1) throw new AppError('Jadwal tidak ditemukan', 404);

    const assistantIds = req.body.assistant_ids || [];
    schedules[idx] = {
        ...schedules[idx],
        course_id:       req.body.course_id,
        lecturer_id:     req.body.lecturer_id,
        class:           req.body.class.toUpperCase(),
        day:             req.body.day,
        time:            req.body.time,
        pj_assistant_id: req.body.pj_assistant_id,
        assistant_ids:   Array.isArray(assistantIds) ? assistantIds : [assistantIds],
    };
    scheduleRepo.write(schedules);
    res.redirect('/jadwal');
}));

// DELETE
router.post('/delete/:id', asyncHandler(async (req, res) => {
    const schedules = scheduleRepo.read();
    const filtered  = schedules.filter(s => s.id !== req.params.id);
    if (filtered.length === schedules.length) throw new AppError('Jadwal tidak ditemukan', 404);
    scheduleRepo.write(filtered);
    res.redirect('/jadwal');
}));

module.exports = router;

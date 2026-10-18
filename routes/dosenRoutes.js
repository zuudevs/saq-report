const { Router } = require('express');
const { lecturerRepo }    = require('../repositories');
const AppError            = require('../config/AppError');
const { asyncHandler, generateId } = require('./_helpers');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
    const lecturers = lecturerRepo.read();
    res.render('dosen', { lecturers, title: 'Manajemen Data Dosen', activePage: 'dosen' });
}));

router.get('/add', (req, res) => {
    res.render('add-dosen', { title: 'Tambah Dosen Baru', activePage: 'dosen' });
});

router.post('/add', asyncHandler(async (req, res) => {
    const lecturers   = lecturerRepo.read();
    const newLecturer = {
        id:         generateId('LECT'),
        name:       req.body.name,
        title:      req.body.title      || '',
        email:      req.body.email      || '',
        phone:      req.body.phone      || '',
        department: req.body.department || '',
    };
    lecturers.push(newLecturer);
    lecturerRepo.write(lecturers);
    res.redirect('/dosen');
}));

router.get('/edit/:id', asyncHandler(async (req, res) => {
    const lecturers = lecturerRepo.read();
    const lecturer  = lecturers.find(l => l.id === req.params.id);
    if (!lecturer) throw new AppError('Dosen tidak ditemukan', 404);
    res.render('edit-dosen', { title: 'Edit Data Dosen', lecturer, activePage: 'dosen' });
}));

router.post('/update/:id', asyncHandler(async (req, res) => {
    const lecturers = lecturerRepo.read();
    const idx       = lecturers.findIndex(l => l.id === req.params.id);
    if (idx === -1) throw new AppError('Dosen tidak ditemukan', 404);

    lecturers[idx] = {
        ...lecturers[idx],
        name:       req.body.name,
        title:      req.body.title      || '',
        email:      req.body.email      || '',
        phone:      req.body.phone      || '',
        department: req.body.department || '',
    };
    lecturerRepo.write(lecturers);
    res.redirect('/dosen');
}));

router.post('/delete/:id', asyncHandler(async (req, res) => {
    const lecturers = lecturerRepo.read();
    const filtered  = lecturers.filter(l => l.id !== req.params.id);
    if (filtered.length === lecturers.length) throw new AppError('Dosen tidak ditemukan', 404);
    lecturerRepo.write(filtered);
    res.redirect('/dosen');
}));

module.exports = router;

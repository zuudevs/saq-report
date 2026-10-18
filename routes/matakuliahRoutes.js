const { Router } = require('express');
const { courseRepo }      = require('../repositories');
const AppError            = require('../config/AppError');
const { asyncHandler, generateId } = require('./_helpers');

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
    const courses = courseRepo.read();
    res.render('matakuliah', { courses, title: 'Manajemen Mata Kuliah', activePage: 'matakuliah' });
}));

router.get('/add', (req, res) => {
    res.render('add-matakuliah', { title: 'Tambah Mata Kuliah Baru', activePage: 'matakuliah' });
});

router.post('/add', asyncHandler(async (req, res) => {
    const courses   = courseRepo.read();
    const creditsVal = parseInt(req.body.credits || req.body.sks, 10) || 0;
    const newCourse = {
        id:          generateId('COURSE'),
        code:        req.body.code.toUpperCase(),
        name:        req.body.name,
        credits:     creditsVal,
        sks:         creditsVal,
        description: req.body.description || '',
        department:  req.body.department  || '',
        semester:    req.body.semester ? parseInt(req.body.semester, 10) : null,
    };
    courses.push(newCourse);
    courseRepo.write(courses);
    res.redirect('/matakuliah');
}));

router.get('/edit/:id', asyncHandler(async (req, res) => {
    const courses = courseRepo.read();
    const course  = courses.find(c => c.id === req.params.id);
    if (!course) throw new AppError('Mata kuliah tidak ditemukan', 404);
    res.render('edit-matakuliah', { title: 'Edit Mata Kuliah', course, activePage: 'matakuliah' });
}));

router.post('/update/:id', asyncHandler(async (req, res) => {
    const courses = courseRepo.read();
    const idx     = courses.findIndex(c => c.id === req.params.id);
    if (idx === -1) throw new AppError('Mata kuliah tidak ditemukan', 404);

    const creditsVal = parseInt(req.body.credits || req.body.sks, 10) || 0;
    courses[idx] = {
        ...courses[idx],
        code:        req.body.code.toUpperCase(),
        name:        req.body.name,
        credits:     creditsVal,
        sks:         creditsVal,
        description: req.body.description || '',
        department:  req.body.department  || '',
        semester:    req.body.semester ? parseInt(req.body.semester, 10) : null,
    };
    courseRepo.write(courses);
    res.redirect('/matakuliah');
}));

// DELETE via AJAX — balas JSON
router.delete('/delete/:id', asyncHandler(async (req, res) => {
    const courses  = courseRepo.read();
    const filtered = courses.filter(c => c.id !== req.params.id);
    if (filtered.length === courses.length) throw new AppError('Mata kuliah tidak ditemukan', 404);
    courseRepo.write(filtered);
    res.json({ success: true });
}));

module.exports = router;

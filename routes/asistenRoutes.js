const { Router } = require('express');
const path             = require('path');
const fs               = require('fs');
const { assistantRepo }   = require('../repositories');
const AppError            = require('../config/AppError');
const { asyncHandler, generateId } = require('./_helpers');
const uploadTtd           = require('../middleware/uploadTtd');
const PATHS               = require('../config/paths');

const router = Router();

// READ
router.get('/', asyncHandler(async (req, res) => {
    const assistants = assistantRepo.read();
    res.render('asisten', { assistants, title: 'Manajemen Data Asisten', activePage: 'asisten' });
}));

// CREATE - Form
router.get('/add', (req, res) => {
    res.render('add-asisten', { title: 'Tambah Asisten Baru', activePage: 'asisten' });
});

// CREATE - Proses
router.post('/add', uploadTtd.single('ttd_image'), asyncHandler(async (req, res) => {
    const assistants   = assistantRepo.read();
    const newAssistant = {
        id:           generateId('ASST'),
        nama_asisten: req.body.nama_asisten.toUpperCase(),
        nama_panjang: req.body.nama_panjang,
        panggilan:    req.body.panggilan,
        no_telp:      req.body.no_telp,
        ttd_image:    req.file ? `/assets/ttd/${req.file.filename}` : '',
    };
    assistants.push(newAssistant);
    assistantRepo.write(assistants);
    res.redirect('/asisten');
}));

// UPDATE - Form
router.get('/edit/:id', asyncHandler(async (req, res) => {
    const assistants = assistantRepo.read();
    const assistant  = assistants.find(a => a.id === req.params.id);
    if (!assistant) throw new AppError('Asisten tidak ditemukan', 404);
    res.render('edit-asisten', { title: 'Edit Data Asisten', assistant, activePage: 'asisten' });
}));

// UPDATE - Proses
router.post('/update/:id', uploadTtd.single('ttd_image'), asyncHandler(async (req, res) => {
    const assistants = assistantRepo.read();
    const idx        = assistants.findIndex(a => a.id === req.params.id);
    if (idx === -1) throw new AppError('Asisten tidak ditemukan', 404);

    // Jika ada file baru diupload, hapus file lama
    let ttdPath = assistants[idx].ttd_image || '';
    if (req.file) {
        // Hapus file TTD lama jika ada
        if (ttdPath) {
            const oldFile = path.join(PATHS.ROOT, ttdPath);
            try { fs.unlinkSync(oldFile); } catch (_) {}
        }
        ttdPath = `/assets/ttd/${req.file.filename}`;
    }

    // Cek apakah user ingin menghapus TTD (checkbox hapus_ttd)
    if (req.body.hapus_ttd === '1' && !req.file) {
        if (ttdPath) {
            const oldFile = path.join(PATHS.ROOT, ttdPath);
            try { fs.unlinkSync(oldFile); } catch (_) {}
        }
        ttdPath = '';
    }

    assistants[idx] = {
        ...assistants[idx],
        nama_asisten: req.body.nama_asisten.toUpperCase(),
        nama_panjang: req.body.nama_panjang,
        panggilan:    req.body.panggilan,
        no_telp:      req.body.no_telp,
        ttd_image:    ttdPath,
    };
    assistantRepo.write(assistants);
    res.redirect('/asisten');
}));

// DELETE
router.post('/delete/:id', asyncHandler(async (req, res) => {
    const assistants   = assistantRepo.read();
    const assistant    = assistants.find(a => a.id === req.params.id);
    if (!assistant) throw new AppError('Asisten tidak ditemukan', 404);

    // Hapus file TTD jika ada
    if (assistant.ttd_image) {
        const ttdFile = path.join(PATHS.ROOT, assistant.ttd_image);
        try { fs.unlinkSync(ttdFile); } catch (_) {}
    }

    const filtered = assistants.filter(a => a.id !== req.params.id);
    assistantRepo.write(filtered);
    res.redirect('/asisten');
}));

module.exports = router;

const path   = require('path');
const { Router } = require('express');

const { reportRepo, assistantRepo } = require('../repositories');
const { getEnrichedSchedules, getEnrichedReports, generateAsistenCalendar } = require('../services/scheduleService');
const upload   = require('../middleware/upload');
const AppError = require('../config/AppError');
const { asyncHandler, generateId } = require('./_helpers');

const router = Router();

// ─── Helper lokal ─────────────────────────────────────────────────────────────

function toArray(val) {
    if (!val) return [];
    return Array.isArray(val) ? val : [val];
}

function formatDateId(dateStr) {
    return new Date(dateStr).toLocaleDateString('id-ID', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// READ: Daftar laporan dengan filter + paginasi
// READ: Daftar laporan dengan filter + paginasi + sort
router.get('/', asyncHandler(async (req, res) => {
    const allReports = getEnrichedReports();
    // Tambahkan sortBy dan sortDir dengan default value (tanggal terbaru)
    const { month, status, search, page = 1, sortBy = 'date', sortDir = 'desc' } = req.query;
    
    let filtered = [...allReports];
    
    // --- 1. FILTER ---
    if (month) {
        filtered = filtered.filter(r => new Date(r.date).getMonth() + 1 == month);
    }
    if (status) {
        filtered = filtered.filter(r => r.status === status);
    }
    
    // --- 2. MULTI-FIELD SEARCH ---
    if (search) {
        const term = search.toLowerCase();
        filtered = filtered.filter(r => {
            const courseName   = (r.course?.name || '').toLowerCase();
            const courseCode   = (r.course?.code || '').toLowerCase();
            const lecturerName = (r.lecturer?.name || '').toLowerCase();
            const schedClass   = (r.schedule?.class || '').toLowerCase();
            const schedDay     = (r.schedule?.day || '').toLowerCase();
            const dateStr      = (r.formattedDate || r.date || '').toLowerCase();
            const statusStr    = (r.status || '').toLowerCase();
            const materiStr    = (r.materi || '').toLowerCase();
            
            // Gabungkan semua nama asisten yang hadir menjadi satu string
            const assistantNames = (r.attendingAssistants || [])
            .map(a => (a.nama_asisten || a.nama_panjang || '').toLowerCase())
            .join(' ');
            
            return courseName.includes(term) ||
            courseCode.includes(term) ||
            lecturerName.includes(term) ||
            schedClass.includes(term) ||
            schedDay.includes(term) ||
            dateStr.includes(term) ||
            statusStr.includes(term) ||
            materiStr.includes(term) ||
            assistantNames.includes(term);
        });
    }
    
    // --- 3. SORTING ---
    filtered.sort((a, b) => {
        let valA, valB;
        switch (sortBy) {
            case 'course':
            valA = (a.course?.name || '').toLowerCase();
            valB = (b.course?.name || '').toLowerCase();
            break;
            case 'lecturer':
            valA = (a.lecturer?.name || '').toLowerCase();
            valB = (b.lecturer?.name || '').toLowerCase();
            break;
            case 'status':
            valA = (a.status || '').toLowerCase();
            valB = (b.status || '').toLowerCase();
            break;
            case 'date':
            default:
            valA = new Date(a.date).getTime() || 0;
            valB = new Date(b.date).getTime() || 0;
            break;
        }
        
        if (valA < valB) return sortDir === 'asc' ? -1 : 1;
        if (valA > valB) return sortDir === 'asc' ? 1 : -1;
        return 0;
    });
    
    // --- 4. PAGINATION ---
    const limit       = 20;
    const totalItems  = filtered.length;
    const totalPages  = Math.ceil(totalItems / limit) || 1; // Pastikan minimal 1 halaman
    
    // Cegah user mengakses halaman yang melebihi batas (misal dari sisa pencarian)
    let currentPage = parseInt(page, 10) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;
    
    const startIdx    = (currentPage - 1) * limit;
    const paginated   = filtered.slice(startIdx, startIdx + limit);
    
    res.render('laporan', {
        title:       'Daftar Laporan Kegiatan',
        reports:     paginated,
        totalPages,
        currentPage,
        // Lempar semua filter ke view agar paginasi dan sorting membawa state terakhir
        filters:     { month, status, search, sortBy, sortDir }, 
        activePage:  'laporan',
    });
}));

// CREATE - Form
router.get('/add', asyncHandler(async (req, res) => {
    const schedules = getEnrichedSchedules();
    const { schedule: scheduleQ, date: dateQ, assistant: assistantQ } = req.query;
    
    const selectedSchedule = scheduleQ
    ? schedules.find(s => s.id === scheduleQ) ?? null
    : null;
    
    res.render('add-laporan', {
        title:            'Tambah Laporan Baru',
        schedules,
        assistants:       assistantRepo.read(),
        prefilled:        { schedule: scheduleQ || '', date: dateQ || '', assistant: assistantQ || '' },
        selectedSchedule,
        activePage:       'laporan',
    });
}));

// CREATE - Proses (dengan upload gambar)
router.post('/add', upload.single('reportImage'), asyncHandler(async (req, res) => {
    const reports    = reportRepo.read();
    const newReport  = {
        id:                     generateId('RPT'),
        schedule_id:            req.body.schedule_id,
        date:                   req.body.date,
        formattedDate:          formatDateId(req.body.date),
        materi:                 req.body.materi            || '',
        deskripsiKegiatan:      req.body.deskripsiKegiatan || '',
        keterangan:             req.body.keterangan        || '',
        attending_assistant_ids: toArray(req.body.attending_assistant_ids),
        status:                 req.body.status,
        author:                 'admin@system.com',
        receivedAt:             new Date().toISOString(),
    };
    
    if (req.file) {
        newReport.imagePath    = path.relative(
            path.join(__dirname, '..'), req.file.path
        ).replace(/\\/g, '/');
        newReport.imageFilename = req.file.filename;
    }
    
    reports.push(newReport);
    reportRepo.write(reports);
    res.redirect('/laporan');
}));

// UPDATE - Form
router.get('/edit/:id', asyncHandler(async (req, res) => {
    const report = getEnrichedReports().find(r => r.id === req.params.id);
    if (!report) throw new AppError('Laporan tidak ditemukan', 404);
    
    res.render('edit-laporan', {
        title:      'Edit Laporan Kegiatan',
        report,
        schedules:  getEnrichedSchedules(),
        assistants: assistantRepo.read(),
        activePage: 'laporan',
    });
}));

// UPDATE - Proses
router.post('/update/:id', asyncHandler(async (req, res) => {
    const reports = reportRepo.read();
    const idx     = reports.findIndex(r => r.id === req.params.id);
    if (idx === -1) throw new AppError('Laporan tidak ditemukan', 404);
    
    reports[idx] = {
        ...reports[idx],
        materi:                 req.body.materi,
        deskripsiKegiatan:      req.body.deskripsiKegiatan,
        keterangan:             req.body.keterangan,
        attending_assistant_ids: toArray(req.body.attending_assistant_ids),
        status:                 req.body.status,
    };
    reportRepo.write(reports);
    res.redirect('/laporan');
}));

// DELETE
router.post('/delete/:id', asyncHandler(async (req, res) => {
    const reports  = reportRepo.read();
    const filtered = reports.filter(r => r.id !== req.params.id);
    if (filtered.length === reports.length) throw new AppError('Laporan tidak ditemukan', 404);
    reportRepo.write(filtered);
    res.redirect('/laporan');
}));

// ─── Asisten View ─────────────────────────────────────────────────────────────

// Pilih kelas
router.get('/asisten', asyncHandler(async (req, res) => {
    const schedules = getEnrichedSchedules();
    
    const classes = schedules.map(s => ({
        scheduleId:   s.id,
        courseName:   s.course?.name    ?? 'Unknown Course',
        courseCode:   s.course?.code    ?? 'N/A',
        lecturerName: s.lecturer?.name  ?? 'Unknown Lecturer',
        class:        s.class,
        day:          s.day,
        time:         s.time,
        pjAssistant:  s.pjAssistant,
        assistants:   s.assistants,
    }));
    
    res.render('asisten-pilih-kelas', {
        title:      'Pilih Kelas - View Asisten',
        classes,
        assistants: assistantRepo.read(),
        activePage: 'laporan',
    });
}));

// Kalender kehadiran per kelas
router.get('/asisten/kelas/:scheduleId', asyncHandler(async (req, res) => {
    const schedules       = getEnrichedSchedules();
    const reports         = reportRepo.read();
    const selectedSchedule = schedules.find(s => s.id === req.params.scheduleId);
    if (!selectedSchedule) throw new AppError('Jadwal tidak ditemukan', 404);
    
    const now         = new Date();
    const targetMonth = req.query.month ? parseInt(req.query.month, 10) : now.getMonth() + 1;
    const targetYear  = req.query.year  ? parseInt(req.query.year,  10) : now.getFullYear();
    
    const calendarData = generateAsistenCalendar(selectedSchedule, reports, targetMonth, targetYear);
    
    res.render('asisten-calendar-view', {
        title:        `Laporan ${selectedSchedule.course?.code} - Kelas ${selectedSchedule.class}`,
        schedule:     selectedSchedule,
        calendarData,
        currentMonth: targetMonth,
        currentYear:  targetYear,
        activePage:   'laporan',
    });
}));

module.exports = router;

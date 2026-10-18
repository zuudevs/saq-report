'use strict';

const { Router } = require('express');
const { globalConfigRepo } = require('../repositories');
const { asyncHandler } = require('./_helpers');

const router = Router();

const MONTH_NAMES = [
    { num: 1, name: 'Januari' },
    { num: 2, name: 'Februari' },
    { num: 3, name: 'Maret' },
    { num: 4, name: 'April' },
    { num: 5, name: 'Mei' },
    { num: 6, name: 'Juni' },
    { num: 7, name: 'Juli' },
    { num: 8, name: 'Agustus' },
    { num: 9, name: 'September' },
    { num: 10, name: 'Oktober' },
    { num: 11, name: 'November' },
    { num: 12, name: 'Desember' },
];

// GET: Tampilkan halaman pengaturan global
router.get('/', asyncHandler(async (req, res) => {
    const config = globalConfigRepo.read() || {};

    res.render('settings', {
        title: 'Pengaturan Global — SAQ Reports',
        activePage: 'settings',
        config,
        monthNames: MONTH_NAMES,
        saved: req.query.saved === 'true',
        error: req.query.error || null,
        tab: req.query.tab || 'semester',
    });
}));

// POST: Simpan form pengaturan global
router.post('/update', asyncHandler(async (req, res) => {
    const currentConfig = globalConfigRepo.read() || {};

    const {
        semester_id,
        semester_name,
        semester_year,
        semester_months,
        system_cron_time,
        system_group_id,
        system_version,
        bot_greetings,
        bot_emojis,
    } = req.body;

    // 1. Semester
    let monthsArr = [];
    if (Array.isArray(semester_months)) {
        monthsArr = semester_months.map(m => parseInt(m, 10)).filter(m => !isNaN(m));
    } else if (semester_months) {
        monthsArr = [parseInt(semester_months, 10)].filter(m => !isNaN(m));
    }

    const updatedSemester = {
        id: (semester_id || currentConfig?.semester?.id || 'SEM_001').trim(),
        name: (semester_name || currentConfig?.semester?.name || '').trim(),
        year: parseInt(semester_year, 10) || currentConfig?.semester?.year || new Date().getFullYear(),
        months: monthsArr.length ? monthsArr : (currentConfig?.semester?.months || [1, 2, 3, 4, 5, 6]),
    };

    // 2. System
    const updatedSystem = {
        cron_time: (system_cron_time || currentConfig?.system?.cron_time || '15:00').trim(),
        group_id: (system_group_id !== undefined ? system_group_id : (currentConfig?.system?.group_id || '')).trim(),
        version: (system_version || currentConfig?.system?.version || '1.0.0').trim(),
        last_updated: new Date().toISOString().slice(0, 10),
    };

    // 3. Bot Messages
    let greetingsArr = [];
    if (typeof bot_greetings === 'string') {
        greetingsArr = bot_greetings
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);
    } else if (Array.isArray(bot_greetings)) {
        greetingsArr = bot_greetings.map(s => String(s).trim()).filter(Boolean);
    }

    let emojisArr = [];
    if (typeof bot_emojis === 'string') {
        emojisArr = bot_emojis
            .split(/[\s,]+/)
            .map(s => s.trim())
            .filter(Boolean);
    } else if (Array.isArray(bot_emojis)) {
        emojisArr = bot_emojis.map(s => String(s).trim()).filter(Boolean);
    }

    const updatedBotMessages = {
        greetings: greetingsArr.length ? greetingsArr : (currentConfig?.bot_messages?.greetings || ['Terima kasih atas laporannya!']),
        emojis: emojisArr.length ? emojisArr : (currentConfig?.bot_messages?.emojis || ['👍', '✨', '🙏', '😊']),
    };

    const newConfig = {
        ...currentConfig,
        semester: updatedSemester,
        system: updatedSystem,
        bot_messages: updatedBotMessages,
    };

    globalConfigRepo.write(newConfig);

    res.redirect('/settings?saved=true&tab=' + (req.body.current_tab || 'semester'));
}));

// POST: Simpan raw JSON langsung
router.post('/update-raw', asyncHandler(async (req, res) => {
    const { raw_json } = req.body;

    if (!raw_json || !raw_json.trim()) {
        return res.redirect('/settings?error=Konten JSON tidak boleh kosong&tab=raw');
    }

    let parsed;
    try {
        parsed = JSON.parse(raw_json);
    } catch (err) {
        return res.redirect('/settings?error=Format JSON tidak valid: ' + encodeURIComponent(err.message) + '&tab=raw');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return res.redirect('/settings?error=JSON harus berupa object configuration valid&tab=raw');
    }

    // Pastikan last_updated diperbarui
    if (parsed.system) {
        parsed.system.last_updated = new Date().toISOString().slice(0, 10);
    }

    globalConfigRepo.write(parsed);

    res.redirect('/settings?saved=true&tab=raw');
}));

// GET: API untuk fetch konfigurasi saat ini
router.get('/api/config', asyncHandler(async (req, res) => {
    const config = globalConfigRepo.read() || {};
    res.json(config);
}));

module.exports = router;

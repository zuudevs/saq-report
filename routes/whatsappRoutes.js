const { Router } = require('express');
const { reportRepo, assistantRepo, globalConfigRepo, scheduleRepo, courseRepo, lecturerRepo } = require('../repositories');
const { getStatus, getQRCode, restartClient, getChats, getClient, getDiagnostics, getLoadingProgress } = require('../services/whatsapp/whatsappClient');
const { generateRemindMessage } = require('../services/messageGeneratorService');
const { getPendingSchedulesThisWeek } = require('../services/dashboardService');
const { asyncHandler } = require('./_helpers');

const router = Router();

// Halaman daftar chat/grup
router.get('/chats', asyncHandler(async (req, res) => {
    const chats = await getChats();
    const assistants = assistantRepo.read();
    
    res.render('whatsapp-chats', {
        title:      'WhatsApp Chats & Groups',
        status:     getStatus(),
        chats:      chats,
        assistants: assistants,
        activePage: 'whatsapp',
    });
}));

// Halaman scan QR Code
router.get('/qr', (req, res) => {
    res.render('whatsapp-qr', {
        title:      'WhatsApp Login - QR Code',
        qrCode:     getQRCode(),
        status:     getStatus(),
        activePage: 'whatsapp',
    });
});

// API endpoint: status real-time (untuk polling di frontend)
router.get('/status', (req, res) => {
    const diag    = typeof getDiagnostics === 'function' ? getDiagnostics() : {};
    const loading = typeof getLoadingProgress === 'function' ? getLoadingProgress() : {};
    res.json({
        status:  getStatus(),
        qrCode:  getQRCode(),
        hasQR:   !!getQRCode(),
        loading: loading,
        ...diag,
    });
});

const { downloadMediaWithFallback } = require('../services/whatsapp/mediaHelper');

// Restart client
router.post('/restart', asyncHandler(async (req, res) => {
    await restartClient();
    res.json({ success: true, message: 'WhatsApp client restarting...' });
}));

// API endpoint: Test download media berdasarkan stanza ID / rawId
router.get('/test-media/:rawId', asyncHandler(async (req, res) => {
    const rawId = req.params.rawId;
    const client = getClient();
    if (!client || !client.pupPage) {
        return res.status(500).json({ error: 'WhatsApp client atau pupPage belum siap' });
    }

    const mockMessage = {
        id: {
            id: rawId,
            remote: '120363424025729902@g.us',
            participant: '3779621605614@lid',
            fromMe: false,
            _serialized: `false_120363424025729902@g.us_${rawId}_3779621605614@lid`,
        },
        hasMedia: true,
        type: 'image',
    };

    const media = await downloadMediaWithFallback(mockMessage, client);
    if (!media || !media.data) {
        return res.status(404).json({ success: false, message: 'Media tidak berhasil diunduh/didekripsi' });
    }

    return res.json({
        success: true,
        mimetype: media.mimetype,
        filename: media.filename,
        filesize: media.filesize,
        dataLength: media.data.length,
        base64Prefix: media.data.slice(0, 50),
    });
}));

// Dashboard manajemen WhatsApp
router.get('/', asyncHandler(async (req, res) => {
    const reports         = reportRepo.read();
    const whatsappReports = reports.filter(r => r.author?.includes('@'));
    const today           = new Date().toDateString();
    const todayReports    = whatsappReports.filter(r =>
        new Date(r.date).toDateString() === today
    );
    
    res.render('whatsapp-dashboard', {
        title:               'WhatsApp Bot Management',
        status:              getStatus(),
        totalWhatsAppReports: whatsappReports.length,
        todayReports:        todayReports.length,
        recentReports:       whatsappReports.slice(-10).reverse(),
        activePage:          'whatsapp',
    });
}));

// API: Send WA Reminder to PJ in group
router.post('/api/remind-pj', asyncHandler(async (req, res) => {
    const { pjName, pjPhone, courseName, courseCode, className, day, time, date } = req.body;
    
    // Ambil group_id dari config_global.json (dinamis, tidak hardcoded)
    const globalConfig = globalConfigRepo.read();
    const GROUP_ID = globalConfig?.system?.group_id;
    
    if (!GROUP_ID) {
        return res.status(500).json({
            success: false,
            message: 'group_id belum dikonfigurasi di config_global.json'
        });
    }
    
    const client = getClient();
    const allowedStatuses = ['ready', 'authenticated'];
    if (!client || !allowedStatuses.includes(getStatus())) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp bot belum siap untuk mengirim reminder. Silakan tunggu proses autentikasi/terhubung selesai.'
        });
    }
    
    if (!pjPhone) {
        return res.status(400).json({
            success: false,
            message: 'Nomor telepon PJ tidak ditemukan.'
        });
    }
    
    // Format nomor WA: 08xxx → 628xxx
    const waNumber = pjPhone.startsWith('0')
    ? '62' + pjPhone.slice(1)
    : pjPhone;
    const mention  = `@${waNumber}`;
    
    // Generate pesan dari Gemini dengan fallback ke template default
    const message = await generateRemindMessage(pjName, pjPhone, courseName, courseCode, className, day, time, date);
    
    try {
        // Jika pesan dari Gemini belum termasuk mention, tambahkan di awal
        let finalMessage = message;
        if (!message.includes('@')) {
            const mention = `@${waNumber}`;
            finalMessage = message.startsWith('📋') 
            ? message 
            : `${mention} ${message}`;
        }
        
        // Kirim langsung ke grup dengan mention (lebih andal daripada getChatById)
        await client.sendMessage(GROUP_ID, finalMessage, {
            mentions: [`${waNumber}@c.us`]
        });
        
        console.log(`[WA-REMIND] Berhasil kirim reminder ke grup untuk PJ: ${pjName} (${pjPhone})`);
        return res.json({
            success: true,
            message: `Reminder berhasil dikirim ke grup untuk @${pjName}`
        });
    } catch (err) {
        console.error('[WA-REMIND] Gagal kirim pesan:', err);
        return res.status(500).json({
            success: false,
            message: `Gagal kirim pesan: ${err.message}`
        });
    }
}));

// API: Broadcast rekap seluruh jadwal pending minggu ini ke grup
router.post('/api/remind-all-pending', asyncHandler(async (req, res) => {
    const globalConfig = globalConfigRepo.read();
    const GROUP_ID = globalConfig?.system?.group_id;

    if (!GROUP_ID) {
        return res.status(500).json({
            success: false,
            message: 'group_id belum dikonfigurasi di config_global.json'
        });
    }

    const client = getClient();
    const allowedStatuses = ['ready', 'authenticated'];
    if (!client || !allowedStatuses.includes(getStatus())) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp bot belum siap. Silakan tunggu proses terhubung selesai.'
        });
    }

    const schedules  = scheduleRepo.read();
    const reports    = reportRepo.read();
    const courses    = courseRepo.read();
    const lecturers  = lecturerRepo.read();
    const assistants = assistantRepo.read();

    const pendingData = getPendingSchedulesThisWeek(
        schedules, reports, courses, lecturers, assistants
    );
    const pendingSchedules = pendingData.schedules || [];

    if (pendingSchedules.length === 0) {
        return res.json({
            success: false,
            message: 'Semua jadwal minggu ini sudah dilaporkan! Tidak ada jadwal yang tertunda.'
        });
    }

    const mentions = [];
    let listText = '';

    pendingSchedules.forEach((item, idx) => {
        const courseName = item.course ? `${item.course.code} - ${item.course.name}` : 'Mata Kuliah';
        let pjTag = 'Belum ada PJ';

        if (item.pjAssistant && item.pjAssistant.no_telp) {
            let phone = item.pjAssistant.no_telp.replace(/\D/g, '');
            if (phone.startsWith('0')) {
                phone = '62' + phone.slice(1);
            }
            pjTag = `@${phone} (${item.pjAssistant.nama_asisten || item.pjAssistant.nama})`;
            mentions.push(`${phone}@c.us`);
        }

        listText += `${idx + 1}. *${courseName}* (Kelas ${item.class})\n` +
                    `   📅 ${item.day}, ${item.time || '-'}\n` +
                    `   👤 PJ: ${pjTag}\n\n`;
    });

    const broadcastMessage =
        `📢 *REKAP JADWAL PRAKTIKUM BELUM MELAPOR*\n` +
        `🗓️ Periode: *${pendingData.weekRange || 'Minggu Ini'}*\n\n` +
        `Berikut daftar jadwal praktikum yang belum mengirimkan laporan:\n\n` +
        listText +
        `Mohon rekan-rekan PJ asisten untuk segera mengirimkan laporan ke grup ini ya. Terima kasih! 🙏`;

    try {
        await client.sendMessage(GROUP_ID, broadcastMessage, { mentions });
        console.log(`[WA-REMIND] Berhasil kirim rekap ${pendingSchedules.length} jadwal pending ke grup.`);
        return res.json({
            success: true,
            message: `Rekap ${pendingSchedules.length} jadwal pending berhasil dikirim ke grup!`
        });
    } catch (err) {
        console.error('[WA-REMIND] Gagal kirim rekap pending ke grup:', err);
        return res.status(500).json({
            success: false,
            message: `Gagal kirim pesan ke grup: ${err.message}`
        });
    }
}));

module.exports = router;

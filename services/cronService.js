const cron = require('node-cron');
const { 
    scheduleRepo, reportRepo, courseRepo, 
    lecturerRepo, assistantRepo, globalConfigRepo
} = require('../repositories');
const { getPendingSchedulesThisWeek } = require('./dashboardService');

// Import fungsi untuk mendapatkan WA client yang aktif
const { getClient } = require('./whatsapp/whatsappClient');

function initDailyReminders() {
    // Berjalan setiap hari pada jam 18:00 WIB
    cron.schedule('0 20 * * *', async () => {
        console.log('[CRON] Menjalankan automasi reminder WA (18:00)...');
        
        try {
            // 1. Ambil data mentah dari repository
            const schedules  = scheduleRepo.read();
            const reports    = reportRepo.read();
            const courses    = courseRepo.read();
            const lecturers  = lecturerRepo.read();
            const assistants = assistantRepo.read();
            const config     = globalConfigRepo.read();
            
            // 2. Gunakan fungsi dashboardService untuk mencari yang masih pending
            const pendingData = getPendingSchedulesThisWeek(
                schedules, reports, courses, lecturers, assistants
            );
            
            const pendingSchedules = pendingData.schedules;
            
            if (pendingSchedules.length === 0) {
                console.log('[CRON] Tidak ada jadwal pending. Reminder tidak dikirim.');
                return;
            }
            
            // 3. Ambil WA Client yang aktif
            const waClient = getClient();
            
            if (!waClient) {
                console.log('[CRON] WA Client tidak aktif. Reminder gagal dikirim.');
                return;
            }
            
            // 4. Dapatkan Group ID tujuan (dari config)
            const targetGroupId = config?.system?.group_id;
            
            if (!targetGroupId) {
                console.log('[CRON] Group ID tidak ditemukan di konfigurasi. Reminder gagal dikirim.');
                return;
            }
            
            // 5. Loop dan kirim WA untuk jadwal yang pending hari ini atau minggu ini
            for (const schedule of pendingSchedules) {
                if (schedule.pjAssistant && schedule.pjAssistant.no_telp) {
                    
                    // Format nomor telepon PJ untuk di-tag
                    let pjPhoneFormatted = schedule.pjAssistant.no_telp.replace(/\D/g, '');
                    if (pjPhoneFormatted.startsWith('0')) {
                        pjPhoneFormatted = '62' + pjPhoneFormatted.slice(1);
                    }
                    const mentionId = `${pjPhoneFormatted}@c.us`;
                    
                    const courseName = schedule.course ? schedule.course.name : 'Mata Kuliah Tidak Diketahui';
                    const courseCode = schedule.course ? schedule.course.code : '-';
                    
                    // Format Pesan (Bisa disesuaikan dengan template kamu)
                    const messageText = `*REMINDER LAPORAN PENDING*\n\n` +
                    `Halo @${pjPhoneFormatted}, jadwal berikut belum ada laporannya minggu ini:\n\n` +
                    `Mata Kuliah: *${courseCode} - ${courseName}*\n` +
                    `Kelas: *${schedule.class}*\n` +
                    `Hari/Waktu: *${schedule.day}, ${schedule.time}*\n` +
                    `Tanggal: *${schedule.formattedDate}*\n\n` +
                    `Mohon segera dikirimkan ya laporannya. Terima kasih! 🙏`;
                    
                    // Kirim pesan ke grup dengan mention
                    await waClient.sendMessage(targetGroupId, messageText, {
                        mentions: [mentionId]
                    });
                    
                    console.log(`[CRON] Reminder terkirim ke: ${schedule.pjAssistant.nama_asisten} (${courseCode})`);
                    
                    // Jeda 3 detik agar tidak kena rate limit
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
            
            console.log('[CRON] Automasi reminder WA selesai!');
            
        } catch (error) {
            console.error('[CRON] Error saat menjalankan automasi reminder:', error);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Jakarta" // Waktu WIB
    });
}

module.exports = { initDailyReminders };
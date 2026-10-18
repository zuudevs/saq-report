const path = require('path');
const fs   = require('fs');

const { reportRepo, globalConfigRepo } = require('../../repositories');
const { findScheduleMatch } = require('../scheduleService');
const {
    findAssistantByPhone,
    resolveSenderPhone,
    convertAssistantNamesToIds,
    parseManualDate,
    getRandomGreeting,
} = require('./whatsappHelpers');
const { downloadMediaWithFallback, normalizeMessageId } = require('./mediaHelper');
const PATHS = require('../../config/paths');

// ─── Caption Parsing ──────────────────────────────────────────────────────────

const CAPTION_PATTERNS = {
    hariTanggal:      /(?:Hari\/Tanggal|Hari|Tanggal)\s*:\s*(.+)/i,
    mataKuliah:       /Mata kuliah\s*:\s*(.+)/i,
    kelas:            /Kelas\s*:\s*(.+)/i,
    materi:           /Materi\s*:\s*(.+)/i,
    deskripsiKegiatan:/Deskripsi Kegiatan\s*:\s*([\s\S]+?)(?=\n\s*(?:Asisten|Keterangan)\s*:|$)/i,
    asisten:          /Asisten\s*:\s*(.+)/i,
    keterangan:       /Keterangan\s*:\s*(.+)/i,
};

function parseCaption(caption) {
    const data = {};
    for (const [key, pattern] of Object.entries(CAPTION_PATTERNS)) {
        const match = caption.match(pattern);
        data[key]   = match?.[1]?.trim() ?? null;
    }
    return data;
}

function generateId(prefix) {
    return `${prefix}_${Date.now().toString().slice(-6)}`;
}

// ─── Message Handler ──────────────────────────────────────────────────────────

/**
* Menangani pesan masuk dari WhatsApp.
* Dependency-injected `whatsappClient` agar tidak tightly coupled.
*/
async function handleIncomingMessage(message, whatsappClient) {
    if (message.id) {
        normalizeMessageId(message.id);
    }

    const chatId          = message.from;
    const senderIndividualId = message.author || chatId;
    
    // ─── Filter Group ──────────────────────────────────────────────────────────
    const globalConfig = globalConfigRepo.read();
    const targetGroupId = globalConfig?.system?.group_id;
    
    const isFromGroup = chatId.endsWith('@g.us');
    
    // Jika pesan dari grup, dan ada group_id di config, pastikan id-nya sama
    if (isFromGroup && targetGroupId && chatId !== targetGroupId) {
        // Abaikan pesan dari grup lain
        return;
    }
    // ────────────────────────────────────────────────────────────────────────────
    
    const resolvedPhone   = await resolveSenderPhone(senderIndividualId, whatsappClient);
    const assistantData   = findAssistantByPhone(resolvedPhone) || findAssistantByPhone(senderIndividualId);
    const senderPanggilan = assistantData?.panggilan ?? null;
    
    // Helper reply — tidak crash jika client sudah mati
    const reply = (text) => {
        if (!whatsappClient) return Promise.resolve();
        const prefix = senderPanggilan ? `${senderPanggilan}, ` : '';
        return whatsappClient.sendMessage(chatId, `${prefix}${text}`);
    };
    
    if (!message.body) return;
    
    const captionLower  = message.body.toLowerCase().trim();
    const hasHari       = captionLower.includes('hari');
    const hasMatkul     = captionLower.includes('mata kuliah');
    const hasAsisten    = captionLower.includes('asisten');
    const isLibur       = captionLower.includes('keterangan') &&
    captionLower.includes('libur');
    
    // Minimal harus ada keyword 'hari', 'mata kuliah', dan 'asisten' agar dianggap laporan
    // (Atau jika itu adalah laporan libur)
    const isAttemptingReport = (hasHari && hasMatkul && hasAsisten) || isLibur;
    
    // Jika bukan format laporan, abaikan saja (agar tidak mengganggu chat biasa)
    if (!isAttemptingReport) {
        return;
    }
    
    // Jika format benar tapi tidak ada gambar (dan bukan libur), ingatkan asisten
    if (message.type !== 'image' && !isLibur) {
        await reply('format laporan terdeteksi, tapi mana gambarnya? Mohon kirim laporan bersama gambar pendukung.');
        return;
    }
    
    console.log(`[WHATSAPP] Pesan diterima dari ${senderIndividualId} (tipe: ${message.type})`);
    
    const caption   = message.body.trim();
    const parsed    = parseCaption(caption);
    
    // ── Validasi 1: Tanggal ────────────────────────────────────────────────────
    if (!parsed.hariTanggal) {
        await reply("laporan tidak lengkap. Field tanggal wajib diisi (format: 'Hari/Tanggal:').");
        return;
    }
    const dateResult = parseManualDate(parsed.hariTanggal);
    if (dateResult.error) {
        await reply(`format Hari/Tanggal salah: ${dateResult.error}`);
        return;
    }
    
    // ── Validasi 2: Jadwal ────────────────────────────────────────────────────
    if (!parsed.mataKuliah || !parsed.kelas) {
        await reply("laporan tidak lengkap. Field 'Mata kuliah' dan 'Kelas' wajib diisi.");
        return;
    }
    const matchedSchedule = findScheduleMatch(parsed.mataKuliah, parsed.kelas);
    if (!matchedSchedule) {
        await reply(`jadwal untuk mata kuliah "${parsed.mataKuliah}" kelas "${parsed.kelas}" tidak ditemukan. Periksa kembali input Anda.`);
        return;
    }
    
    // ── Validasi 3: Materi (wajib untuk laporan hadir) ───────────────────────
    if (!isLibur && !parsed.materi) {
        await reply("laporan tidak lengkap. Field 'Materi' wajib diisi.");
        return;
    }
    
    // ── Validasi 4: Nama asisten ──────────────────────────────────────────────
    let assistantIds = [];
    if (parsed.asisten) {
        const result = convertAssistantNamesToIds(parsed.asisten);
        if (result.error) {
            await reply(`Nama asisten tidak valid: ${result.error} Pastikan nama sudah terdaftar.`);
            return;
        }
        assistantIds = result.ids;
    }
    
    // ── Buat objek laporan ────────────────────────────────────────────────────
    const newReport = {
        id:                    generateId('RPT'),
        schedule_id:           matchedSchedule.id,
        date:                  dateResult.isoDate,
        formattedDate:         dateResult.formattedString,
        materi:                parsed.materi,
        deskripsiKegiatan:     parsed.deskripsiKegiatan,
        keterangan:            parsed.keterangan,
        attending_assistant_ids: assistantIds,
        status:                'hadir',
        imagePath:             null,
        imageFilename:         null,
        author:                senderIndividualId,
        receivedAt:            new Date().toISOString(),
    };
    
    try {
        // Baca data laporan yang ada
        const reports = reportRepo.read();
        
        // Cek apakah sudah ada laporan untuk jadwal (matkul+kelas) dan hari yang sama
        const existingIndex = reports.findIndex(
            r => r.schedule_id === newReport.schedule_id && r.date === newReport.date
        );
        
        // ── Laporan libur (tidak butuh gambar) ────────────────────────────────
        if (isLibur) {
            newReport.status     = 'libur';
            newReport.keterangan = newReport.keterangan || 'Libur';
            
            if (existingIndex !== -1) {
                // Update / Overwrite
                newReport.id = reports[existingIndex].id; // Pertahankan ID lama
                reports[existingIndex] = newReport;
                await reply('oke, laporan libur sebelumnya sudah di-update 👍');
            } else {
                // Insert baru
                reports.push(newReport);
                await reply('oke, laporan libur sudah dicatat 👍');
            }
            
            reportRepo.write(reports);
            console.log(`[WHATSAPP] Laporan libur disimpan/diupdate (ID: ${newReport.id})`);
            return;
        }
        
        // ── Download dan simpan gambar ────────────────────────────────────────
        if (message.id) {
            normalizeMessageId(message.id);
        }

        let media;
        try {
            media = await downloadMediaWithFallback(message, whatsappClient);
        } catch (downloadErr) {
            console.error(`[WHATSAPP] Gagal downloadMedia dari ${senderIndividualId}:`, downloadErr);
        }

        if (!media?.data) {
            await reply('gagal memproses gambar (tidak bisa diunduh dari WhatsApp). Coba kirim ulang ya.');
            return;
        }
        
        const [year, month, day] = dateResult.isoDate.split('-');
        const targetDir = path.join(PATHS.UPLOAD_DIR, year, month, day);
        fs.mkdirSync(targetDir, { recursive: true });
        
        const ext           = media.mimetype.split('/')[1] || 'jpg';
        const imageFileName = `laporan_${Date.now()}.${ext}`;
        const absImagePath  = path.join(targetDir, imageFileName);
        fs.writeFileSync(absImagePath, Buffer.from(media.data, 'base64'));
        
        newReport.imagePath    = path.join('laporan_images', year, month, day, imageFileName).replace(/\\/g, '/');
        newReport.imageFilename = imageFileName;
        newReport.status       = parsed.keterangan?.toLowerCase().includes('pengganti')
        ? 'pengganti' : 'hadir';
        
        if (existingIndex !== -1) {
            const oldReport = reports[existingIndex];
            
            // Opsional tapi disarankan: Hapus gambar lama biar disk nggak bengkak
            if (oldReport.imagePath) {
                try {
                    // Pastikan path untuk menghapus file sesuai dengan struktur folder-mu
                    const oldImagePath = path.join(PATHS.UPLOAD_DIR, '..', oldReport.imagePath); 
                    if (fs.existsSync(oldImagePath)) {
                        fs.unlinkSync(oldImagePath);
                    }
                } catch (e) {
                    console.error('[WHATSAPP] Gagal menghapus gambar lama:', e);
                }
            }
            
            // Update / Overwrite
            newReport.id = oldReport.id; // Pertahankan ID lama
            reports[existingIndex] = newReport;
            await reply(`${getRandomGreeting()}! Laporan sebelumnya udah aku update yah.`);
            
        } else {
            // Insert baru
            reports.push(newReport);
            await reply(`${getRandomGreeting()}! Laporannya aku terima yah.`);
        }
        
        reportRepo.write(reports);
        console.log(`[WHATSAPP] Laporan dari ${senderIndividualId} disimpan/diupdate (ID: ${newReport.id})`);
        
    } catch (err) {
        console.error(`[WHATSAPP] Error memproses laporan dari ${senderIndividualId}:`, err);
        await reply('maaf, terjadi kesalahan internal saat memproses laporanmu. 😔 Coba lapor ke admin ya.');
    }
    
}

module.exports = { handleIncomingMessage };

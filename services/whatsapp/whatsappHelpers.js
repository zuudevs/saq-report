const { assistantRepo, globalConfigRepo } = require('../../repositories');

// ─── Assistant Lookup ──────────────────────────────────────────────────────────

/**
* Mencari data asisten berdasarkan WhatsApp ID (nomor@c.us).
* @param {string} whatsappId
* @returns {object|null}
*/
function findAssistantByPhone(whatsappId) {
    if (!whatsappId || typeof whatsappId !== 'string') return null;
    
    const assistants      = assistantRepo.read();
    const numberFromWa    = whatsappId.split('@')[0];
    
    return assistants.find(a => {
        if (!a?.no_telp) return false;
        let normalized = a.no_telp.replace(/\D/g, '');
        if (normalized.startsWith('0')) {
            normalized = '62' + normalized.slice(1);
        }
        return numberFromWa.endsWith(normalized) || whatsappId.startsWith(normalized);
    }) ?? null;
}

/**
 * Mencoba me-resolve nomor asli jika pengirim menggunakan WhatsApp LID (@lid).
 * @param {string} senderId
 * @param {object} whatsappClient
 * @returns {Promise<string>}
 */
async function resolveSenderPhone(senderId, whatsappClient) {
    if (!senderId || typeof senderId !== 'string') return senderId;
    if (!senderId.endsWith('@lid') || typeof whatsappClient?.getContactLidAndPhone !== 'function') {
        return senderId;
    }
    try {
        const contactInfo = await whatsappClient.getContactLidAndPhone([senderId]);
        if (contactInfo?.[0]?.pn) {
            return contactInfo[0].pn;
        }
    } catch (e) {
        // Abaikan jika gagal resolve
    }
    return senderId;
}

/**
* Mengubah daftar nama asisten (CSV string) menjadi array ID.
* @returns {{ ids: string[] } | { error: string, invalidName: string }}
*/
function convertAssistantNamesToIds(namesString) {
    if (!namesString || typeof namesString !== 'string') return { ids: [] };
    
    const assistants = assistantRepo.read();
    const names      = namesString.split(',').map(n => n.trim().toLowerCase());
    const ids        = [];
    
    for (const name of names) {
        const found = assistants.find(
            a => a.nama_asisten.toLowerCase() === name ||
            a.panggilan.toLowerCase()    === name
        );
        if (found) {
            ids.push(found.id);
        } else {
            return { error: `Asisten "${name}" tidak ditemukan.`, invalidName: name };
        }
    }
    
    return { ids };
}

// ─── Date Parsing ─────────────────────────────────────────────────────────────

const DAYS_ID  = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTHS_ID = {
    januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5,
    juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11,
};
const MONTHS_ID_LABEL = [
    'Januari','Februari','Maret','April','Mei','Juni',
    'Juli','Agustus','September','Oktober','November','Desember',
];

/**
* Mem-parse string tanggal bahasa Indonesia ke objek terstruktur.
* Mendukung format: "Rabu, 16 April 2025" atau "2025, April, 16"
* @returns {{ dateObject, formattedString, isoDate } | { error: string }}
*/
function parseManualDate(dateString) {
    const original = dateString;
    const cleaned  = dateString
    .toLowerCase()
    .replace(/\s*\/\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/^,|,$/g, '')
    .trim();
    
    const dayPattern   = DAYS_ID.map(d => d.toLowerCase()).join('|');
    const monthPattern = Object.keys(MONTHS_ID).join('|');
    
    let day = null, monthIdx = null, year = null;
    
    // Pattern 1: [Hari,] DD MonthName YYYY
    const p1 = new RegExp(
        `^(?:(?:${dayPattern})[,\\s]*)?(\\d{1,2})[,\\s]+(${monthPattern})[,\\s]+(\\d{4})$`
    );
    let m = cleaned.match(p1);
    if (m) {
        day = parseInt(m[1], 10);
        monthIdx = MONTHS_ID[m[2]];
        year = parseInt(m[3], 10);
    }
    
    // Pattern 2: YYYY MonthName DD
    if (day === null) {
        const p2 = new RegExp(`^(\\d{4})[,\\s]+(${monthPattern})[,\\s]+(\\d{1,2})$`);
        m = cleaned.match(p2);
        if (m) {
            year = parseInt(m[1], 10);
            monthIdx = MONTHS_ID[m[2]];
            day = parseInt(m[3], 10);
        }
    }
    
    if (day === null || monthIdx === null || year === null) {
        return { error: `Format tanggal tidak dikenali: "${original}". Contoh: 'Rabu, 16 April 2025'.` };
    }
    
    if (year < 1900 || year > 2100) {
        return { error: `Tahun tidak valid: ${year}.` };
    }
    
    const maxDay = new Date(year, monthIdx + 1, 0).getDate();
    if (day < 1 || day > maxDay) {
        return { error: `Tanggal ${day} tidak valid untuk ${MONTHS_ID_LABEL[monthIdx]} ${year}.` };
    }
    
    const dateObj      = new Date(year, monthIdx, day);
    const dayName      = DAYS_ID[dateObj.getDay()];
    const monthName    = MONTHS_ID_LABEL[monthIdx];
    const isoDate      = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    return {
        dateObject:      dateObj,
        formattedString: `${dayName}, ${day} ${monthName} ${year}`,
        isoDate,
    };
}

// ─── Misc ──────────────────────────────────────────────────────────────────────

function getRandomGreeting() {
    const config = globalConfigRepo.read();
    const greetings = (config?.bot_messages?.greetings && config.bot_messages.greetings.length > 0)
        ? config.bot_messages.greetings
        : [
            "THX u",
            "IZIIIINNN",
            "Oke siap cuy",
            "Mantap sekali NTe",
            "ANE Hebat!",
            "Surat cinta diterima",
            "Nah gini dong gak php lagi",
            "mantap kamu gak ghosting",
            "Horee",
            "Akhirnyaa",
            "Dari tadi dong",
            "Plis laa",
            "ASEEKKK atas laporannya"
        ];

    const emojis = (config?.bot_messages?.emojis && config.bot_messages.emojis.length > 0)
        ? config.bot_messages.emojis
        : ['👍', '🙏', '✨', '😊'];

    const chosenGreeting = greetings[Math.floor(Math.random() * greetings.length)];
    const chosenEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    return `${chosenGreeting} ${chosenEmoji}`;
}

function isTargetClosedError(error) {
    const msg = (error?.message ?? '').toLowerCase();
    return msg.includes('target closed') || msg.includes('protocol error');
}

module.exports = {
    findAssistantByPhone,
    resolveSenderPhone,
    convertAssistantNamesToIds,
    parseManualDate,
    getRandomGreeting,
    isTargetClosedError,
};

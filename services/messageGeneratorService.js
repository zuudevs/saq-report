const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyAyebU67zmND0wwt5ws6ozVv-qDSMdRCmM';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

/**
* Generate pesan reminder dengan gaya Gen Z yang sinis dari Gemini
* Jika gagal, gunakan template default
*/
async function generateRemindMessage(pjName, pjPhone, courseName, courseCode, className, day, time, date) {
    const defaultMessage = getDefaultMessage(pjName, pjPhone, courseName, courseCode, className, day, time, date);
    
    try {
        const prompt = `Kamu adalah asisten bot yang helpful tapi sarkastis dan pakai bahasa Gen Z terkini. 
Buatkan pesan reminder untuk ${pjName} yang belum ngisi laporan dengan gaya santai, sarkastis, tapi tetap profesional. 
Gunakan bahasa gen z, bisa pakai kata-kata seperti BOS, joks bapa bapa garing, puitis, woi, jangan sampai gw jewer jewerin kuping lu semua, seperti bos, kamu harus bertindak SEPERTI BOS CEO(lucu seperti drama cina).
        
Data:
- Nama: ${pjName}
- Mata Kuliah: ${courseCode} - ${courseName}
- Kelas: ${className}
- Hari: ${day} (${date})
- Jam: ${time}
        
Buatkan pesan yang:
1. Dimulai dengan emoji yang cocok
2. Sarkastis tapi tetap mengajak action
3. Menggunakan bahasa Gen Z yang natural
4. Singkat tapi punchy (3-5 kalimat)
5. Format untuk WhatsApp (boleh pakai bold dengan * dan emoji)
6. jangan mengandung agama
7. JANGAN LUPA DATA DIATAS HARUS ADA DALAM PESAN, JANGAN ADA YANG KURANG, JANGAN ADA YANG LEBIH.
        
Respons HANYA berupa pesan, tanpa penjelasan tambahan.`;
        
        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            {
                contents: [
                    {
                        parts: [
                            {
                                text: prompt
                            }
                        ]
                    }
                ]
            },
            {
                timeout: 30000 // timeout 30 detik
            }
        );
        
        const generatedText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (generatedText && generatedText.trim()) {
            console.log('[MESSAGE-GEN] Berhasil generate pesan dari Gemini');
            return generatedText.trim();
        }
        
        throw new Error('Response dari Gemini kosong');
    } catch (err) {
        console.warn('[MESSAGE-GEN] Gagal generate dari Gemini:', err.message);
        console.log('[MESSAGE-GEN] Menggunakan template default');
        return defaultMessage;
    }
}

/**
* Template default jika Gemini gagal
*/
function getDefaultMessage(pjName, pjPhone, courseName, courseCode, className, day, time, date) {
    const waNumber = pjPhone.startsWith('0') ? '62' + pjPhone.slice(1) : pjPhone;
    const mention = `@${waNumber}`;
    
    return (
        `📋 *Reminder Pengisian Laporan*\n\n` +
        `Halo ${mention}, kamu belum mengisi laporan untuk jadwal berikut:\n\n` +
        `📚 *${courseCode} - ${courseName}*\n` +
        `🏫 Kelas: *${className}*\n` +
        `📅 Hari: *${day}* (${date})\n` +
        `🕐 Jam: *${time}*\n\n` +
        `Mohon segera isi laporan ya. Terima kasih! 🙏`
    );
}

module.exports = {
    generateRemindMessage,
    getDefaultMessage
};

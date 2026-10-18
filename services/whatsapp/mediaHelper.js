'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { MessageMedia } = require('whatsapp-web.js');

/**
 * Normalisasi ID pesan untuk memastikan string _serialized dan $1 valid
 * serta tidak mengandung `[object Object]` yang sering terjadi pada akun @lid.
 */
function normalizeMessageId(messageId) {
    if (!messageId || typeof messageId !== 'object') return messageId;

    const rawId = typeof messageId.id === 'string' ? messageId.id : '';
    const remote = typeof messageId.remote === 'object' && messageId.remote
        ? (messageId.remote._serialized || messageId.remote.$1 || (messageId.remote.user && messageId.remote.server ? `${messageId.remote.user}@${messageId.remote.server}` : ''))
        : (typeof messageId.remote === 'string' ? messageId.remote : '');
        
    const participant = typeof messageId.participant === 'object' && messageId.participant
        ? (messageId.participant._serialized || messageId.participant.$1 || (messageId.participant.user && messageId.participant.server ? `${messageId.participant.user}@${messageId.participant.server}` : ''))
        : (typeof messageId.participant === 'string' ? messageId.participant : '');

    const hasCorruptSerialized = typeof messageId._serialized === 'string' && messageId._serialized.includes('[object Object]');
    const hasCorrupt$1 = typeof messageId.$1 === 'string' && messageId.$1.includes('[object Object]');

    if (!messageId._serialized || hasCorruptSerialized) {
        if (messageId.$1 && !hasCorrupt$1) {
            messageId._serialized = messageId.$1;
        } else if (remote && rawId) {
            messageId._serialized = participant
                ? `${Boolean(messageId.fromMe)}_${remote}_${rawId}_${participant}`
                : `${Boolean(messageId.fromMe)}_${remote}_${rawId}`;
        }
    }

    if (!messageId.$1 || hasCorrupt$1) {
        messageId.$1 = messageId._serialized;
    }

    return messageId;
}

/**
 * Mengumpulkan semua kandidat string ID yang mungkin dikenali oleh WhatsApp Web.
 */
function getCandidateMessageIds(message) {
    const idObj = message.id || {};
    const rawId = typeof idObj.id === 'string' ? idObj.id : (typeof message.id === 'string' ? message.id : '');

    const remote = typeof idObj.remote === 'object' && idObj.remote
        ? (idObj.remote._serialized || idObj.remote.$1 || (idObj.remote.user && idObj.remote.server ? `${idObj.remote.user}@${idObj.remote.server}` : ''))
        : (typeof idObj.remote === 'string' ? idObj.remote : '');

    const participant = typeof idObj.participant === 'object' && idObj.participant
        ? (idObj.participant._serialized || idObj.participant.$1 || (idObj.participant.user && idObj.participant.server ? `${idObj.participant.user}@${idObj.participant.server}` : ''))
        : (typeof idObj.participant === 'string' ? idObj.participant : (message.author || ''));

    const fromMe = Boolean(idObj.fromMe);

    const candidates = new Set();

    if (typeof idObj._serialized === 'string' && !idObj._serialized.includes('[object Object]')) {
        candidates.add(idObj._serialized);
    }
    if (typeof idObj.$1 === 'string' && !idObj.$1.includes('[object Object]')) {
        candidates.add(idObj.$1);
    }
    if (remote && rawId) {
        if (participant) {
            candidates.add(`${fromMe}_${remote}_${rawId}_${participant}`);
            if (participant.endsWith('@lid')) {
                candidates.add(`${fromMe}_${remote}_${rawId}_${participant.replace('@lid', '@c.us')}`);
            }
        }
        candidates.add(`${fromMe}_${remote}_${rawId}`);
    }

    return {
        candidateIds: Array.from(candidates),
        rawId
    };
}

/**
 * Menurunkan kunci enkripsi WhatsApp (IV, CipherKey, MacKey) menggunakan HKDF-SHA256
 * sesuai spesifikasi resmi protokol media WhatsApp.
 */
function deriveWhatsAppKeys(mediaKeyBase64, mediaType = 'image') {
    const mediaKey = Buffer.isBuffer(mediaKeyBase64)
        ? mediaKeyBase64
        : Buffer.from(mediaKeyBase64, 'base64');

    const infoMap = {
        image: 'WhatsApp Image Keys',
        video: 'WhatsApp Video Keys',
        audio: 'WhatsApp Audio Keys',
        document: 'WhatsApp Document Keys',
        sticker: 'WhatsApp Image Keys'
    };
    const info = infoMap[mediaType] || infoMap.image;
    const salt = Buffer.alloc(32, 0);
    const hkdfKey = crypto.hkdfSync('sha256', mediaKey, salt, Buffer.from(info, 'utf8'), 112);
    const keyBuf = Buffer.from(hkdfKey);

    return {
        iv: keyBuf.subarray(0, 16),
        cipherKey: keyBuf.subarray(16, 48),
        macKey: keyBuf.subarray(48, 80),
        refKey: keyBuf.subarray(80, 112)
    };
}

/**
 * Mendekripsi buffer media WhatsApp (.enc) menggunakan AES-256-CBC
 * dengan fallback fleksibel untuk panjang MAC (10-byte, 32-byte, atau tanpa stripping).
 */
function safeDecryptMedia(encBuffer, mediaKeyBase64, mediaType = 'image') {
    if (!Buffer.isBuffer(encBuffer)) {
        encBuffer = Buffer.from(encBuffer);
    }
    const { iv, cipherKey } = deriveWhatsAppKeys(mediaKeyBase64, mediaType);
    const macLengths = [10, 32, 0];
    let lastError = null;

    for (const macLen of macLengths) {
        if (encBuffer.length <= macLen) continue;
        try {
            const ciphertext = macLen > 0
                ? encBuffer.subarray(0, encBuffer.length - macLen)
                : encBuffer;
            const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
            const decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]);
            if (decrypted && decrypted.length > 0) {
                return decrypted;
            }
        } catch (err) {
            lastError = err;
        }
    }
    throw (lastError || new Error('Gagal mendekripsi media buffer'));
}

/**
 * Mengunduh media terenkripsi langsung dari CDN WhatsApp menggunakan Axios dan mendekripsinya di Node.js.
 */
async function fetchCdnAndDecrypt(directPath, mediaKeyBase64, mediaType = 'image', hostname = 'mmg.whatsapp.net') {
    if (!directPath) throw new Error('directPath kosong');
    if (!mediaKeyBase64) throw new Error('mediaKeyBase64 kosong');

    const cleanHost = hostname || 'mmg.whatsapp.net';
    const fullUrl = directPath.startsWith('http')
        ? directPath
        : `https://${cleanHost}${directPath.startsWith('/') ? '' : '/'}${directPath}`;

    console.log(`[WHATSAPP-MEDIA] Mengunduh encrypted media dari WhatsApp CDN: ${fullUrl.split('?')[0]}`);

    const response = await axios.get(fullUrl, {
        responseType: 'arraybuffer',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Origin': 'https://web.whatsapp.com',
            'Referer': 'https://web.whatsapp.com/',
            'Accept': '*/*'
        },
        timeout: 25000,
    });

    const encBuffer = Buffer.from(response.data);
    console.log(`[WHATSAPP-MEDIA] Encrypted media berhasil diunduh (${encBuffer.length} bytes), mendekripsi via AES-256-CBC...`);

    const decryptedBuffer = safeDecryptMedia(encBuffer, mediaKeyBase64, mediaType);
    console.log(`[WHATSAPP-MEDIA] ✅ Berhasil didekripsi (${decryptedBuffer.length} bytes). Magic: ${decryptedBuffer.subarray(0, 4).toString('hex')}`);

    return decryptedBuffer;
}

/**
 * Mengunduh media WhatsApp dengan fallback multi-strategy untuk menangani
 * isu WhatsApp Web terbaru (error "t: t" pada pengirim @lid dan perubahan struktur ID).
 *
 * @param {object} message Objek Message dari whatsapp-web.js
 * @param {object} whatsappClient Objek Client dari whatsapp-web.js
 * @returns {Promise<MessageMedia|null>}
 */
async function downloadMediaWithFallback(message, whatsappClient) {
    if (!message) return null;

    // Normalisasi ID pesan sebelum pemrosesan
    if (message.id) {
        normalizeMessageId(message.id);
    }

    // ── Strategy 1: Coba method bawaan message.downloadMedia() dulu ───────────
    try {
        if (typeof message.downloadMedia === 'function') {
            const media = await message.downloadMedia();
            if (media && media.data) {
                console.log('[WHATSAPP-MEDIA] ✅ Media berhasil diunduh via message.downloadMedia().');
                return media;
            }
        }
    } catch (standardErr) {
        console.warn('[WHATSAPP-MEDIA] Standard downloadMedia gagal (mencoba custom multi-strategy solver):', standardErr?.message || standardErr);
    }

    // ── Strategy 2: Browser evaluation & multi-tier extractor ─────────────────
    const pupPage = whatsappClient?.pupPage || message.client?.pupPage;
    if (!pupPage) {
        console.error('[WHATSAPP-MEDIA] pupPage tidak tersedia untuk fallback download');
        return null;
    }

    const { candidateIds, rawId } = getCandidateMessageIds(message);
    console.log(`[WHATSAPP-MEDIA] Memulai multi-strategy fallback solver untuk rawId: ${rawId}`);

    let result;
    try {
        result = await pupPage.evaluate(async (candidateIds, rawId) => {
            const diags = [];
            try {
                const Collections = window.require('WAWebCollections');
                const MsgCollection = Collections?.Msg;
                if (!MsgCollection) {
                    return { success: false, diags: ['WAWebCollections.Msg tidak ditemukan'] };
                }

                // ── 1. Cari Model Pesan di Memory ──
                let msg = null;
                let foundSource = '';

                // Level A: Msg.get langsung dengan string ID kandidat
                for (const cid of candidateIds) {
                    if (!cid) continue;
                    try {
                        msg = MsgCollection.get(cid);
                        if (msg) {
                            foundSource = `MsgCollection.get(${cid})`;
                            break;
                        }
                    } catch (e) {
                        diags.push(`Msg.get(${cid}) throw: ${e?.message}`);
                    }
                }

                // Level B: Cari di MsgCollection.models menggunakan raw stanza ID
                if (!msg && MsgCollection.models && rawId) {
                    msg = MsgCollection.models.find(m => {
                        if (!m || !m.id) return false;
                        return m.id.id === rawId;
                    });
                    if (msg) foundSource = `MsgCollection.models rawId(${rawId})`;
                }

                // Level C: Cari di MsgCollection.models berdasarkan _serialized atau $1
                if (!msg && MsgCollection.models) {
                    msg = MsgCollection.models.find(m => {
                        if (!m || !m.id) return false;
                        const mSer = m.id._serialized;
                        const m1 = m.id.$1;
                        return candidateIds.some(cid => cid && (cid === mSer || cid === m1));
                    });
                    if (msg) foundSource = 'MsgCollection.models serialized/$1';
                }

                // Level D: Cari di daftar pesan per Chat
                if (!msg && rawId && Collections?.Chat?.models) {
                    for (const chat of Collections.Chat.models) {
                        if (chat?.msgs?.models) {
                            const found = chat.msgs.models.find(m => m?.id?.id === rawId);
                            if (found) {
                                msg = found;
                                foundSource = `Chat(${chat.id?._serialized}).msgs rawId(${rawId})`;
                                break;
                            }
                        }
                    }
                }

                // Level E: getMessagesById dengan try/catch aman
                if (!msg && typeof MsgCollection.getMessagesById === 'function') {
                    for (const cid of candidateIds) {
                        if (!cid) continue;
                        try {
                            const res = await MsgCollection.getMessagesById([cid]);
                            if (res?.messages?.[0]) {
                                msg = res.messages[0];
                                foundSource = `getMessagesById(${cid})`;
                                break;
                            }
                        } catch (e) {
                            diags.push(`getMessagesById(${cid}) throw: ${e?.message}`);
                        }
                    }
                }

                if (!msg) {
                    return { success: false, diags: [...diags, 'Pesan tidak ditemukan di memori WhatsApp Web'] };
                }

                diags.push(`Pesan ditemukan via ${foundSource}`);

                // Helper konversi ke Base64
                function toBase64(val) {
                    if (!val) return null;
                    if (typeof val === 'string') return val;
                    if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
                        const bytes = new Uint8Array(val);
                        let binary = '';
                        for (let i = 0; i < bytes.byteLength; i++) {
                            binary += String.fromCharCode(bytes[i]);
                        }
                        return btoa(binary);
                    }
                    if (typeof val === 'object') {
                        if (typeof val._base64 === 'string') return val._base64;
                        if (typeof val.base64 === 'string') return val.base64;
                        if (Array.isArray(val.data)) {
                            return btoa(String.fromCharCode(...val.data));
                        }
                        const numKeys = Object.keys(val).filter(k => !isNaN(k));
                        if (numKeys.length > 0) {
                            const bytes = numKeys.sort((a,b)=>Number(a)-Number(b)).map(k => val[k]);
                            return btoa(String.fromCharCode(...bytes));
                        }
                    }
                    return null;
                }

                // Helper resolusi properti serbaguna
                function getProp(prop) {
                    if (msg[prop] !== undefined && msg[prop] !== null) return msg[prop];
                    if (msg.mediaData && msg.mediaData[prop] !== undefined && msg.mediaData[prop] !== null) return msg.mediaData[prop];
                    if (msg.attributes && msg.attributes[prop] !== undefined && msg.attributes[prop] !== null) return msg.attributes[prop];
                    if (msg.attributes?.mediaData && msg.attributes.mediaData[prop] !== undefined && msg.attributes.mediaData[prop] !== null) return msg.attributes.mediaData[prop];
                    if (msg[`__x_${prop}`] !== undefined && msg[`__x_${prop}`] !== null) return msg[`__x_${prop}`];
                    return undefined;
                }

                // ── 2. Periksa Blob atau RenderableUrl yang sudah ada ──
                if (msg.mediaData?._blob) {
                    try {
                        const ab = await msg.mediaData._blob.arrayBuffer();
                        const b64 = await window.WWebJS.arrayBufferToBase64Async(ab);
                        return {
                            success: true,
                            source: 'browser_blob',
                            data: b64,
                            mimetype: msg.mimetype || msg.mediaData?.mimetype || 'image/jpeg',
                            filename: msg.filename,
                            filesize: ab.byteLength,
                            diags
                        };
                    } catch (e) {
                        diags.push(`blob read gagal: ${e?.message}`);
                    }
                }

                if (msg.mediaData?.renderableUrl) {
                    try {
                        const r = await fetch(msg.mediaData.renderableUrl);
                        const blob = await r.blob();
                        const ab = await blob.arrayBuffer();
                        const b64 = await window.WWebJS.arrayBufferToBase64Async(ab);
                        return {
                            success: true,
                            source: 'browser_renderableUrl',
                            data: b64,
                            mimetype: blob.type || msg.mimetype || 'image/jpeg',
                            filename: msg.filename,
                            filesize: ab.byteLength,
                            diags
                        };
                    } catch (e) {
                        diags.push(`renderableUrl fetch gagal: ${e?.message}`);
                    }
                }

                // ── 3. Ekstraksi Metadata Media ──
                let directPath = getProp('directPath') || getProp('deprecatedMms3Url') || getProp('clientUrl');
                let rawMediaKey = getProp('mediaKey');
                let mediaKeyBase64 = toBase64(rawMediaKey);
                let encFilehash = toBase64(getProp('encFilehash'));
                let filehash = toBase64(getProp('filehash'));
                let mediaKeyTimestamp = getProp('mediaKeyTimestamp');
                let type = getProp('type') || 'image';
                let mimetype = getProp('mimetype') || 'image/jpeg';
                let filename = getProp('filename') || `media_${Date.now()}`;
                let filesize = getProp('size') || getProp('fileLength');
                let hostname = getProp('hostname') || 'mmg.whatsapp.net';

                diags.push(`Metadata awal: directPath=${Boolean(directPath)}, mediaKey=${Boolean(mediaKeyBase64)}, stage=${msg.mediaData?.mediaStage}`);

                // Jika directPath atau mediaKey belum ada, coba panggil msg.downloadMedia() untuk memicu fetching
                if ((!directPath || !mediaKeyBase64) && typeof msg.downloadMedia === 'function') {
                    try {
                        await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
                    } catch (dmErr) {
                        diags.push(`msg.downloadMedia() trigger error: ${dmErr?.message || String(dmErr)}`);
                    }
                    // Re-check properties
                    directPath = directPath || getProp('directPath') || getProp('deprecatedMms3Url') || getProp('clientUrl');
                    rawMediaKey = rawMediaKey || getProp('mediaKey');
                    mediaKeyBase64 = mediaKeyBase64 || toBase64(rawMediaKey);
                    encFilehash = encFilehash || toBase64(getProp('encFilehash'));
                    filehash = filehash || toBase64(getProp('filehash'));
                    diags.push(`Metadata paska-trigger: directPath=${Boolean(directPath)}, mediaKey=${Boolean(mediaKeyBase64)}, stage=${msg.mediaData?.mediaStage}`);
                }

                // Cek lagi apakah blob/renderableUrl baru saja terisi
                if (msg.mediaData?._blob) {
                    try {
                        const ab = await msg.mediaData._blob.arrayBuffer();
                        const b64 = await window.WWebJS.arrayBufferToBase64Async(ab);
                        return {
                            success: true,
                            source: 'browser_blob_post_trigger',
                            data: b64,
                            mimetype,
                            filename,
                            filesize: ab.byteLength,
                            diags
                        };
                    } catch (_) {}
                }
                if (msg.mediaData?.renderableUrl) {
                    try {
                        const r = await fetch(msg.mediaData.renderableUrl);
                        const blob = await r.blob();
                        const ab = await blob.arrayBuffer();
                        const b64 = await window.WWebJS.arrayBufferToBase64Async(ab);
                        return {
                            success: true,
                            source: 'browser_renderableUrl_post_trigger',
                            data: b64,
                            mimetype: blob.type || mimetype,
                            filename,
                            filesize: ab.byteLength,
                            diags
                        };
                    } catch (_) {}
                }

                // ── 4. Coba DownloadManager bawaan WA Web ──
                let DownloadManager = null;
                try {
                    const dmMod = window.require('WAWebDownloadManager');
                    DownloadManager = dmMod?.downloadManager || dmMod;
                } catch (e) {
                    diags.push(`require(WAWebDownloadManager) error: ${e?.message}`);
                }

                if (DownloadManager?.downloadAndMaybeDecrypt && directPath && (rawMediaKey || mediaKeyBase64)) {
                    try {
                        const mockQpl = new Proxy({}, {
                            get: (target, prop) => {
                                if (prop === 'then') return undefined;
                                return (...args) => mockQpl;
                            }
                        });
                        const decryptedMedia = await DownloadManager.downloadAndMaybeDecrypt({
                            directPath,
                            encFilehash,
                            filehash,
                            mediaKey: rawMediaKey || mediaKeyBase64,
                            mediaKeyTimestamp,
                            type,
                            signal: new AbortController().signal,
                            downloadQpl: mockQpl,
                        });
                        if (decryptedMedia) {
                            const b64 = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia);
                            return {
                                success: true,
                                source: 'browser_DownloadManager',
                                data: b64,
                                mimetype,
                                filename,
                                filesize: decryptedMedia.byteLength,
                                diags
                            };
                        }
                    } catch (dmDecErr) {
                        diags.push(`DownloadManager.downloadAndMaybeDecrypt error: ${dmDecErr?.message || String(dmDecErr)}`);
                    }
                }

                // ── 5. Coba Browser fetch ke CDN langsung ──
                if (directPath) {
                    try {
                        const fullUrl = directPath.startsWith('http')
                            ? directPath
                            : `https://${hostname}${directPath.startsWith('/') ? '' : '/'}${directPath}`;
                        const cdnRes = await fetch(fullUrl, { mode: 'cors' });
                        if (cdnRes.ok) {
                            const ab = await cdnRes.arrayBuffer();
                            const encB64 = await window.WWebJS.arrayBufferToBase64Async(ab);
                            return {
                                success: false,
                                hasEncryptedData: true,
                                encryptedDataBase64: encB64,
                                mediaKeyBase64,
                                directPath,
                                type,
                                mimetype,
                                filename,
                                filesize,
                                hostname,
                                diags: [...diags, `Browser fetch CDN berhasil (${ab.byteLength} bytes)`]
                            };
                        } else {
                            diags.push(`Browser fetch CDN status: ${cdnRes.status}`);
                        }
                    } catch (bfErr) {
                        diags.push(`Browser fetch CDN error: ${bfErr?.message || String(bfErr)}`);
                    }
                }

                // ── 6. Kembalikan metadata ke Node.js untuk diunduh dan didekripsi via Axios + Crypto ──
                return {
                    success: false,
                    hasEncryptedData: false,
                    directPath,
                    mediaKeyBase64,
                    type,
                    mimetype,
                    filename,
                    filesize,
                    hostname,
                    diags
                };
            } catch (evalErr) {
                return {
                    success: false,
                    error: evalErr?.message || String(evalErr),
                    diags: [...diags, `Evaluate crash: ${evalErr?.message || String(evalErr)}`]
                };
            }
        }, candidateIds, rawId);
    } catch (pageErr) {
        console.error('[WHATSAPP-MEDIA] pupPage.evaluate gagal dieksekusi:', pageErr);
        return null;
    }

    if (!result) {
        console.error('[WHATSAPP-MEDIA] Fallback download gagal: result dari browser null');
        return null;
    }

    if (result.diags && result.diags.length > 0) {
        console.log('[WHATSAPP-MEDIA] Diagnostic Info:\n  • ' + result.diags.join('\n  • '));
    }

    // Kasus A: Browser berhasil mendekripsi langsung
    if (result.success && result.data) {
        console.log(`[WHATSAPP-MEDIA] ✅ Media berhasil diperoleh via browser (${result.source}).`);
        return new MessageMedia(
            result.mimetype || 'image/jpeg',
            result.data,
            result.filename,
            result.filesize
        );
    }

    // Kasus B: Browser berhasil mengambil payload terenkripsi (.enc)
    if (result.hasEncryptedData && result.encryptedDataBase64 && result.mediaKeyBase64) {
        try {
            console.log('[WHATSAPP-MEDIA] Mendekripsi buffer terenkripsi dari browser di Node.js via HKDF + AES-256-CBC...');
            const encBuf = Buffer.from(result.encryptedDataBase64, 'base64');
            const decryptedBuf = safeDecryptMedia(encBuf, result.mediaKeyBase64, result.type || 'image');
            console.log(`[WHATSAPP-MEDIA] ✅ Berhasil didekripsi di Node.js (${decryptedBuf.length} bytes).`);
            return new MessageMedia(
                result.mimetype || 'image/jpeg',
                decryptedBuf.toString('base64'),
                result.filename,
                decryptedBuf.length
            );
        } catch (nodeDecErr) {
            console.error('[WHATSAPP-MEDIA] Dekripsi data browser di Node.js gagal:', nodeDecErr.message);
        }
    }

    // Kasus C: Node.js mengunduh langsung dari CDN WhatsApp menggunakan directPath + mediaKey
    if (result.directPath && result.mediaKeyBase64) {
        try {
            console.log('[WHATSAPP-MEDIA] Mengunduh langsung dari CDN WhatsApp dan mendekripsi di Node.js...');
            const decryptedBuf = await fetchCdnAndDecrypt(
                result.directPath,
                result.mediaKeyBase64,
                result.type || 'image',
                result.hostname || 'mmg.whatsapp.net'
            );
            return new MessageMedia(
                result.mimetype || 'image/jpeg',
                decryptedBuf.toString('base64'),
                result.filename,
                decryptedBuf.length
            );
        } catch (cdnErr) {
            console.error('[WHATSAPP-MEDIA] Unduh CDN WhatsApp langsung gagal:', cdnErr.message);
        }
    }

    console.error('[WHATSAPP-MEDIA] Semua metode download dan dekripsi media telah dicoba namun belum berhasil.');
    return null;
}

module.exports = {
    downloadMediaWithFallback,
    normalizeMessageId,
    getCandidateMessageIds,
    deriveWhatsAppKeys,
    safeDecryptMedia,
    fetchCdnAndDecrypt,
};

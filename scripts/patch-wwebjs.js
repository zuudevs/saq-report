'use strict';
const fs = require('fs');
const path = require('path');

const messagePath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'structures', 'Message.js');

if (!fs.existsSync(messagePath)) {
    console.log('[PATCH] Message.js tidak ditemukan, lewati patch.');
    process.exit(0);
}

let content = fs.readFileSync(messagePath, 'utf8');
let modified = false;

// ── Patch 1: Normalisasi this.id (dukungan $1, LID, dan cegah [object Object]) ─
const idPatchMarker = '// PATCH_WWEBJS_ID_NORMALIZED';
if (!content.includes(idPatchMarker)) {
    const oldPatchRegex = /this\.id = data\.id;[\s\S]*?if \(!this\.id\.\$1 && this\.id\._serialized\) \{[\s\S]*?this\.id\.\$1 = this\.id\._serialized;[\s\S]*?\}/;
    const replacement = `this.id = data.id; ${idPatchMarker}
        if (this.id) {
            const rawId = typeof this.id.id === 'string' ? this.id.id : '';
            const remote = typeof this.id.remote === 'object' && this.id.remote
                ? (this.id.remote._serialized || this.id.remote.$1 || (this.id.remote.user && this.id.remote.server ? \`\${this.id.remote.user}@\${this.id.remote.server}\` : ''))
                : (typeof this.id.remote === 'string' ? this.id.remote : '');
            const participant = typeof this.id.participant === 'object' && this.id.participant
                ? (this.id.participant._serialized || this.id.participant.$1 || (this.id.participant.user && this.id.participant.server ? \`\${this.id.participant.user}@\${this.id.participant.server}\` : ''))
                : (typeof this.id.participant === 'string' ? this.id.participant : '');

            const hasCorrupt = typeof this.id._serialized === 'string' && this.id._serialized.includes('[object Object]');
            if (!this.id._serialized || hasCorrupt) {
                if (this.id.$1 && !this.id.$1.includes('[object Object]')) {
                    this.id._serialized = this.id.$1;
                } else if (remote && rawId) {
                    this.id._serialized = participant
                        ? \`\${Boolean(this.id.fromMe)}_\${remote}_\${rawId}_\${participant}\`
                        : \`\${Boolean(this.id.fromMe)}_\${remote}_\${rawId}\`;
                }
            }
            if (!this.id.$1 || (typeof this.id.$1 === 'string' && this.id.$1.includes('[object Object]'))) {
                this.id.$1 = this.id._serialized;
            }
        }`;

    if (oldPatchRegex.test(content)) {
        content = content.replace(oldPatchRegex, replacement);
        modified = true;
    } else if (content.includes('this.id = data.id;')) {
        content = content.replace('this.id = data.id;', replacement);
        modified = true;
    }
}

// ── Patch 2: Ganti evaluate raw this.id._serialized dengan fallback $1 ─────────
const serializedCall = '}, this.id._serialized);';
const serializedCallFixed = '}, this.id?._serialized || this.id?.$1);';
if (content.includes(serializedCall)) {
    content = content.split(serializedCall).join(serializedCallFixed);
    modified = true;
}

// ── Patch 3: Patch downloadMedia agar tidak melempar "t: t" pada pesan @lid ──
const downloadMediaMarker = '// PATCH_WWEBJS_DOWNLOAD_MEDIA_SAFE';
if (!content.includes(downloadMediaMarker)) {
    const targetDownload = `                if (msg.mediaData.mediaStage != 'RESOLVED') {
                    // try to resolve media
                    await msg.downloadMedia({
                        downloadEvenIfExpensive: true,
                        rmrReason: 1,
                    });
                }`;

    const safeDownload = `                ${downloadMediaMarker}
                if (msg.mediaData.mediaStage != 'RESOLVED') {
                    // try to resolve media
                    try {
                        await msg.downloadMedia({
                            downloadEvenIfExpensive: true,
                            rmrReason: 1,
                        });
                    } catch (dmErr) {
                        // ignore and attempt direct downloadAndMaybeDecrypt
                    }
                }`;

    if (content.includes(targetDownload)) {
        content = content.replace(targetDownload, safeDownload);
        modified = true;
    }

    // Proxy mockQpl
    const targetQpl = `                const mockQpl = {
                    addAnnotations: function () {
                        return this;
                    },
                    addPoint: function () {
                        return this;
                    },
                };`;

    const safeQpl = `                const mockQpl = new Proxy({}, {
                    get: (target, prop) => {
                        if (prop === 'then') return undefined;
                        return (...args) => mockQpl;
                    }
                });`;

    if (content.includes(targetQpl)) {
        content = content.replace(targetQpl, safeQpl);
        modified = true;
    }
}

// ── Patch 4: Safe catch in downloadMedia (mencegah error "t: t" bubbling ke Node) ─
const throwMarker = '// PATCH_WWEBJS_NO_THROW_T';
if (!content.includes(throwMarker)) {
    const targetCatch = `            } catch (e) {
                if (e.status && e.status === 404) return undefined;
                throw e;
            }`;
    const safeCatch = `            } catch (e) {
                ${throwMarker}
                if (e.status && e.status === 404) return undefined;
                return undefined;
            }`;
    if (content.includes(targetCatch)) {
        content = content.replace(targetCatch, safeCatch);
        modified = true;
    }
}

// ── Patch 5: RawId model lookup in downloadMedia ──
const lookupMarker = '// PATCH_WWEBJS_RAW_LOOKUP';
if (!content.includes(lookupMarker)) {
    const targetLookup = `                const msg =
                    window.require('WAWebCollections').Msg.get(msgId) ||
                    (
                        await window
                            .require('WAWebCollections')
                            .Msg.getMessagesById([msgId])
                    )?.messages?.[0];`;
    const safeLookup = `                ${lookupMarker}
                const ColMsg = window.require('WAWebCollections').Msg;
                let msg = ColMsg.get(msgId);
                if (!msg && typeof ColMsg.getMessagesById === 'function') {
                    try {
                        msg = (await ColMsg.getMessagesById([msgId]))?.messages?.[0];
                    } catch (_) {}
                }
                if (!msg && ColMsg.models) {
                    const raw = String(msgId).split('_')[2] || msgId;
                    msg = ColMsg.models.find(m => m && m.id && (m.id.id === raw || m.id._serialized === msgId || m.id.$1 === msgId));
                }`;
    if (content.includes(targetLookup)) {
        content = content.replace(targetLookup, safeLookup);
        modified = true;
    }
}

if (modified) {
    fs.writeFileSync(messagePath, content, 'utf8');
    console.log('[PATCH] Berhasil mem-patch whatsapp-web.js Message.js untuk kompatibilitas $1, LID, dan safe downloadMedia.');
} else {
    console.log('[PATCH] whatsapp-web.js Message.js sudah up-to-date.');
}

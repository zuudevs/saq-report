'use strict';

/**
 * services/exportService.js
 *
 * Layanan terpadu untuk export dokumen praktikum SAQ:
 * 1. Rekap Kehadiran Bulanan (XLSX) -> Export/[tahun]/rekap_kehadiran/
 * 2. Berita Acara Praktikum per Kelas (XLSX) -> Export/[tahun]/berita_acara/
 * 3. Laporan Harian Praktikum (DOCX) -> Export/[tahun]/laporan_harian/[bulan]/
 */

const fs = require('fs');
const path = require('path');
const PATHS = require('../config/paths');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const ExcelJS = require('exceljs');

let sizeOf = null;
try {
    sizeOf = require('image-size');
} catch (_) {
    // image-size optional fallback
}

const {
    assistantRepo,
    lecturerRepo,
    courseRepo,
    scheduleRepo,
    reportRepo,
    globalConfigRepo,
} = require('../repositories');

const {
    buildAttendanceGrid,
    formatJam,
} = require('./attendanceService');

// =============================================================================
// == KONFIGURASI PATH TEMPLATE & ASSET ==
// =============================================================================

const ROOT_DIR = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const EXPORT_BASE_DIR = path.join(ROOT_DIR, 'Export');

const TEMPLATE_DOCX_PATH = path.join(TEMPLATES_DIR, 'template_saq.docx');
const TEMPLATE_BERITA_ACARA_PATH = path.join(TEMPLATES_DIR, 'template_berita_acara.xlsx');
const TEMPLATE_REKAP_PATH = path.join(TEMPLATES_DIR, 'Rekap_Ngawas_Lab.xlsx');

const LOGO_ITPLN_PATH = path.join(ASSETS_DIR, 'ITPLN.webp');
const LOGO_SAQ_PATH = path.join(ASSETS_DIR, 'SAQ.webp');

const TABLE_ANCHOR_PLACEHOLDER = '###TABLE_ANCHOR###';

// =============================================================================
// == HELPER DIREKTORI EXPORT ==
// =============================================================================

/**
 * Menghasilkan struktur path output untuk tahun tertentu:
 * Export/[tahun]/
 *   ├── rekap_kehadiran/
 *   ├── berita_acara/
 *   └── laporan_harian/
 */
function getExportDirs(year) {
    const config = globalConfigRepo.read();
    const currentSem = config?.semester || {};
    let folderName;

    if (typeof year === 'string' && year.includes('-')) {
        folderName = year;
    } else if (currentSem.academic_year && (!year || currentSem.academic_year.includes(String(year)))) {
        folderName = currentSem.academic_year;
    } else {
        folderName = String(year || currentSem.year || new Date().getFullYear());
    }

    const baseYearDir = path.join(EXPORT_BASE_DIR, folderName);
    const rekapDir = path.join(baseYearDir, 'rekap_kehadiran');
    const beritaAcaraDir = path.join(baseYearDir, 'berita_acara');
    const laporanHarianDir = path.join(baseYearDir, 'laporan_harian');

    return {
        baseYearDir,
        rekapDir,
        beritaAcaraDir,
        laporanHarianDir,
    };
}

/**
 * Memastikan semua folder tujuan export ada.
 */
function ensureExportDirs(year) {
    const dirs = getExportDirs(year);
    fs.mkdirSync(dirs.rekapDir, { recursive: true });
    fs.mkdirSync(dirs.beritaAcaraDir, { recursive: true });
    fs.mkdirSync(dirs.laporanHarianDir, { recursive: true });
    return dirs;
}

// =============================================================================
// == UTILITAS TANGGAL BAHASA INDONESIA ==
// =============================================================================

const DAY_MAP_ID = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
const MONTH_MAP_ID = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

function getDayNameID(date) {
    const jsDay = date.getDay();
    const pyWeekday = jsDay === 0 ? 6 : jsDay - 1;
    return DAY_MAP_ID[pyWeekday];
}

function formatDateIndonesian(date) {
    const day = getDayNameID(date);
    const tgl = String(date.getDate()).padStart(2, '0');
    const bulan = MONTH_MAP_ID[date.getMonth()];
    const tahun = date.getFullYear();
    return `${day}, ${tgl} ${bulan} ${tahun}`;
}

function parseDateIndonesian(dateStr) {
    if (!dateStr) return new Date();
    const cleaned = dateStr.replace(',', '').trim();
    const parts = cleaned.split(/\s+/);
    // Format yang didukung: "Senin 03 Maret 2025" atau "03 Maret 2025"
    let tgl, bulanStr, tahun;
    if (parts.length >= 4) {
        tgl = parseInt(parts[1], 10);
        bulanStr = parts[2];
        tahun = parseInt(parts[3], 10);
    } else if (parts.length === 3) {
        tgl = parseInt(parts[0], 10);
        bulanStr = parts[1];
        tahun = parseInt(parts[2], 10);
    } else {
        return new Date(dateStr);
    }

    const bulanIdx = MONTH_MAP_ID.indexOf(bulanStr);
    if (bulanIdx === -1) {
        return new Date(dateStr);
    }
    return new Date(tahun, bulanIdx, tgl);
}

function getMonthNameIDLower(date) {
    return MONTH_MAP_ID[date.getMonth()].toLowerCase();
}

function formatFilenameDate(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const dayName = getDayNameID(date);
    return `${yyyy}_${mm}_${dd}_${dayName}`;
}

function isoDateString(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function normalizeDateFormat(dateStr) {
    if (!dateStr) return dateStr;
    return dateStr.replace(/,\s(\d)\s/, ', 0$1 ');
}

function cleanCellValue(value) {
    if (value === null || value === undefined) return '';
    const cleaned = String(value).trim().toLowerCase();
    if (cleaned === 'none' || cleaned === 'n/a') return '';
    return String(value).trim();
}

// =============================================================================
// == 1. STRUKTUR DATA KOMPREHENSIF DENGAN PLACEHOLDER ==
// =============================================================================

function buildComprehensiveListWithPlaceholders() {
    const assistantsArr = assistantRepo.read();
    const lecturersArr = lecturerRepo.read();
    const coursesArr = courseRepo.read();
    const schedules = scheduleRepo.read();
    const globalConfig = globalConfigRepo.read();
    const actualReports = reportRepo.read();

    if (!assistantsArr || !lecturersArr || !coursesArr || !schedules || !globalConfig) {
        console.warn('[EXPORT] Gagal memuat salah satu data master. Proses dibatalkan.');
        return null;
    }

    const assistants = Object.fromEntries(assistantsArr.map(a => [a.id, a]));
    const lecturers = Object.fromEntries(lecturersArr.map(l => [l.id, l]));
    const courses = Object.fromEntries(coursesArr.map(c => [c.id, c]));

    const semesterInfo = globalConfig.semester || {};
    const semesterYear = semesterInfo.year || new Date().getFullYear();
    const semesterMonths = semesterInfo.months || [];

    if (!semesterMonths.length) {
        console.warn('[EXPORT] Bulan semester tidak didefinisikan dalam global config.');
        return null;
    }

    const allPossibleReports = [];
    const firstMonth = semesterMonths[0];
    const lastMonth  = semesterMonths[semesterMonths.length - 1];
    const startDate  = new Date(semesterYear, firstMonth - 1, 1);

    const endYear = (lastMonth < firstMonth) ? semesterYear + 1 : semesterYear;
    const endDate = new Date(endYear, lastMonth, 0);

    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
        const currentMonth1Based = currentDate.getMonth() + 1;

        if (semesterMonths.includes(currentMonth1Based)) {
            const dayName = getDayNameID(currentDate);
            const isoDate = isoDateString(currentDate);

            const reportsForThisDate = actualReports.filter(r => r.date === isoDate);
            const schedulesForDay = schedules.filter(s => s.day === dayName);

            // Lewati jika hari libur/akhir pekan tanpa jadwal & laporan
            if (schedulesForDay.length === 0 && reportsForThisDate.length === 0) {
                currentDate.setDate(currentDate.getDate() + 1);
                continue;
            }

            const processedScheduleIds = new Set();

            // 1. Proses laporan aktual
            for (const actualReport of reportsForThisDate) {
                const scheduleId = actualReport.schedule_id;
                processedScheduleIds.add(scheduleId);

                const scheduleInfo = schedules.find(s => s.id === scheduleId) || {};
                const courseInfo = courses[scheduleInfo.course_id] || {};
                const lecturerInfo = lecturers[scheduleInfo.lecturer_id] || {};

                const combinedRecord = {
                    hariTanggal: actualReport.formattedDate || formatDateIndonesian(currentDate),
                    materi: actualReport.materi,
                    deskripsiKegiatan: actualReport.deskripsiKegiatan,
                    keterangan: actualReport.keterangan,
                    status: actualReport.status || 'hadir',
                    imagePath: actualReport.imagePath,
                    asisten: (actualReport.attending_assistant_ids || [])
                        .map(id => (assistants[id] || {}).panggilan || 'N/A'),
                    mataKuliah: courseInfo.name || actualReport.mataKuliah || 'N/A',
                    kelas: scheduleInfo.class || actualReport.kelas || '',
                    jam: scheduleInfo.time || actualReport.jam || '',
                    day: scheduleInfo.day || dayName,
                    sks: courseInfo.sks ?? courseInfo.credits ?? 0,
                    dosen: lecturerInfo.name || 'N/A',
                };
                allPossibleReports.push(combinedRecord);
            }

            // 2. Proses jadwal rutin yang belum ada laporan (placeholder)
            for (const scheduleInfo of schedulesForDay) {
                if (processedScheduleIds.has(scheduleInfo.id)) continue;

                const courseInfo = courses[scheduleInfo.course_id] || {};
                const lecturerInfo = lecturers[scheduleInfo.lecturer_id] || {};

                const combinedRecord = {
                    hariTanggal: formatDateIndonesian(currentDate),
                    materi: null,
                    deskripsiKegiatan: null,
                    keterangan: null,
                    status: 'belum ada laporan',
                    imagePath: null,
                    asisten: (scheduleInfo.assistant_ids || [])
                        .map(id => (assistants[id] || {}).panggilan || 'N/A'),
                    mataKuliah: courseInfo.name,
                    kelas: scheduleInfo.class,
                    jam: scheduleInfo.time,
                    day: scheduleInfo.day || dayName,
                    sks: courseInfo.sks ?? courseInfo.credits ?? 0,
                    dosen: lecturerInfo.name,
                };
                allPossibleReports.push(combinedRecord);
            }
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }

    return allPossibleReports;
}

// =============================================================================
// == 2. PEMBUATAN LAPORAN HARIAN (DOCX) ==
// =============================================================================

function escapeXml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildTableXml(dataRecords) {
    const columnWidthsPct = [5, 15, 7, 13, 10, 22, 14, 14];
    const headers = ['No', 'Mata Kuliah', 'Kelas', 'Dosen', 'Materi', 'Deskripsi Kegiatan', 'Asisten', 'Keterangan'];

    const gridColsXml = columnWidthsPct
        .map(pct => `<w:gridCol w:w="${Math.round(pct * 50)}"/>`)
        .join('');

    const borderNames = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
    const bordersXml = borderNames
        .map(name => `<w:${name} w:val="single" w:sz="4" w:color="auto"/>`)
        .join('');

    const headerCellsXml = headers
        .map(h =>
            `<w:tc>` +
            `<w:p>` +
            `<w:pPr><w:jc w:val="center"/></w:pPr>` +
            `<w:r><w:rPr><w:b/></w:rPr><w:t>${escapeXml(h)}</w:t></w:r>` +
            `</w:p>` +
            `</w:tc>`
        )
        .join('');
    const headerRowXml = `<w:tr>${headerCellsXml}</w:tr>`;

    const dataRowsXml = dataRecords
        .map((record, i) => {
            const asistanStr = (record.asisten || []).join(', ');
            const values = [
                String(i + 1),
                cleanCellValue(record.mataKuliah),
                cleanCellValue(record.kelas),
                cleanCellValue(record.dosen),
                cleanCellValue(record.materi),
                cleanCellValue(record.deskripsiKegiatan),
                cleanCellValue(asistanStr),
                cleanCellValue(record.keterangan),
            ];

            const cellsXml = values
                .map((val, idx) => {
                    const centerXml = idx === 0 ? `<w:pPr><w:jc w:val="center"/></w:pPr>` : '';
                    return (
                        `<w:tc>` +
                        `<w:tcPr><w:vAlign w:val="center"/></w:tcPr>` +
                        `<w:p>${centerXml}` +
                        `<w:r><w:t xml:space="preserve">${escapeXml(val)}</w:t></w:r>` +
                        `</w:p>` +
                        `</w:tc>`
                    );
                })
                .join('');

            return `<w:tr>${cellsXml}</w:tr>`;
        })
        .join('');

    return (
        `<w:tbl>` +
        `<w:tblPr>` +
        `<w:tblW w:w="5000" w:type="pct"/>` +
        `<w:tblLayout w:type="fixed"/>` +
        `<w:tblGrid>${gridColsXml}</w:tblGrid>` +
        `<w:tblBorders>${bordersXml}</w:tblBorders>` +
        `</w:tblPr>` +
        headerRowXml +
        dataRowsXml +
        `</w:tbl>`
    );
}

function replaceAnchorParagraphWithTable(docXml, anchorText, tableXml) {
    const pRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
    let match;

    while ((match = pRegex.exec(docXml)) !== null) {
        const pContent = match[0];
        const plainText = pContent.replace(/<[^>]+>/g, '');
        if (plainText.includes(anchorText)) {
            return (
                docXml.slice(0, match.index) +
                tableXml +
                docXml.slice(match.index + pContent.length)
            );
        }
    }

    return docXml;
}

function appendParagraphXml(docXml, text) {
    const paraXml = `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
    return docXml.replace(/<\/w:body>/, paraXml + '</w:body>');
}

function appendImageToDocXml(zip, docXml, fullImagePath, imgCounter) {
    try {
        const imageBuffer = fs.readFileSync(fullImagePath);
        const ext = path.extname(fullImagePath).toLowerCase();

        const extMap = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.gif': 'gif', '.bmp': 'bmp', '.webp': 'png' };
        const extNorm = extMap[ext] || 'jpeg';
        const ctMap = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp' };
        const contentType = ctMap[extNorm] || 'image/jpeg';

        let targetWidthEmu = 1500000;
        let targetHeightEmu = 900000;

        if (sizeOf) {
            try {
                const dims = sizeOf(imageBuffer);
                if (dims.width && dims.height) {
                    targetHeightEmu = Math.round(targetWidthEmu * (dims.height / dims.width));
                }
            } catch (_) {}
        }

        const mediaName = `image_${imgCounter}${ext === '.webp' ? '.png' : ext}`;
        const mediaPath = `word/media/${mediaName}`;
        zip.file(mediaPath, imageBuffer);

        const relsPath = 'word/_rels/document.xml.rels';
        let relsXml = zip.files[relsPath].asText();
        const rId = `rIdImg${imgCounter}`;
        const newRel =
            `<Relationship Id="${rId}" ` +
            `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
            `Target="media/${mediaName}"/>`;
        relsXml = relsXml.replace('</Relationships>', newRel + '</Relationships>');
        zip.file(relsPath, relsXml);

        const ctPath = '[Content_Types].xml';
        let ctXml = zip.files[ctPath].asText();
        if (!ctXml.includes(`Extension="${extNorm}"`)) {
            const newDefault = `<Default Extension="${extNorm}" ContentType="${contentType}"/>`;
            ctXml = ctXml.replace('</Types>', newDefault + '</Types>');
            zip.file(ctPath, ctXml);
        }

        const drawingXml =
            `<w:p><w:r><w:drawing>` +
            `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
            `distT="0" distB="0" distL="0" distR="0">` +
            `<wp:extent cx="${targetWidthEmu}" cy="${targetHeightEmu}"/>` +
            `<wp:docPr id="${imgCounter}" name="Picture ${imgCounter}"/>` +
            `<wp:cNvGraphicFramePr>` +
            `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
            `</wp:cNvGraphicFramePr>` +
            `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
            `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:nvPicPr>` +
            `<pic:cNvPr id="${imgCounter}" name="Picture ${imgCounter}"/>` +
            `<pic:cNvPicPr/>` +
            `</pic:nvPicPr>` +
            `<pic:blipFill>` +
            `<a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
            `<a:stretch><a:fillRect/></a:stretch>` +
            `</pic:blipFill>` +
            `<pic:spPr>` +
            `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${targetWidthEmu}" cy="${targetHeightEmu}"/></a:xfrm>` +
            `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
            `</pic:spPr>` +
            `</pic:pic>` +
            `</a:graphicData>` +
            `</a:graphic>` +
            `</wp:inline>` +
            `</w:drawing></w:r></w:p>`;

        return docXml.replace(/<\/w:body>/, drawingXml + '</w:body>');
    } catch (err) {
        console.warn(`[DOCX] Gagal menambahkan gambar ${path.basename(fullImagePath)}: ${err.message}`);
        return docXml;
    }
}

/**
 * Membuat satu berkas laporan harian DOCX untuk satu tanggal.
 */
function createSingleReportForDay(hariTanggalLaporan, dataRecordsForDay, globalConfig, options = {}) {
    try {
        const dtObject = parseDateIndonesian(hariTanggalLaporan);
        const year = options.year || dtObject.getFullYear() || (globalConfig.semester || {}).year || new Date().getFullYear();
        const monthName = getMonthNameIDLower(dtObject);

        const dirs = ensureExportDirs(year);
        const outputDirForMonth = path.join(dirs.laporanHarianDir, monthName);
        fs.mkdirSync(outputDirForMonth, { recursive: true });

        const semesterName = (globalConfig.semester || {}).name || 'N/A';
        const outputFilename = `${formatFilenameDate(dtObject)}.docx`;
        const outputPath = path.join(outputDirForMonth, outputFilename);

        if (!fs.existsSync(TEMPLATE_DOCX_PATH)) {
            throw new Error(`Template DOCX '${TEMPLATE_DOCX_PATH}' tidak ditemukan.`);
        }

        const templateBuf = fs.readFileSync(TEMPLATE_DOCX_PATH);
        const zip = new PizZip(templateBuf);
        let docXml = zip.files['word/document.xml'].asText();

        // Ganti placeholder hari_tanggal & tahun_periode_semester langsung di XML
        docXml = docXml
            .replace(/\{\{[\s\S]*?hari_tanggal[\s\S]*?\}\}/g, escapeXml(hariTanggalLaporan))
            .replace(/\{\{[\s\S]*?tahun_periode_semester[\s\S]*?\}\}/g, escapeXml(semesterName));

        const tableXml = buildTableXml(dataRecordsForDay);
        docXml = replaceAnchorParagraphWithTable(docXml, TABLE_ANCHOR_PLACEHOLDER, tableXml);

        let imageCounter = 0;
        for (const record of dataRecordsForDay) {
            imageCounter++;
            const captionText =
                `${imageCounter}. ${record.mataKuliah || 'N/A'} ` +
                `${record.kelas || ''} (${record.jam || ''})`;

            docXml = appendParagraphXml(docXml, captionText);

            const imagePathStr = record.imagePath;
            if (imagePathStr) {
                const fullImagePath = path.isAbsolute(imagePathStr)
                    ? imagePathStr
                    : path.resolve(ROOT_DIR, imagePathStr);

                if (fs.existsSync(fullImagePath)) {
                    docXml = appendImageToDocXml(zip, docXml, fullImagePath, imageCounter);
                }
            }
        }

        zip.file('word/document.xml', docXml);
        const outputBuffer = zip.generate({ type: 'nodebuffer' });
        fs.writeFileSync(outputPath, outputBuffer);

        return outputPath;
    } catch (err) {
        console.error(`[DOCX] Gagal membuat laporan untuk ${hariTanggalLaporan}:`, err.message);
        throw err;
    }
}

/**
 * Menghasilkan semua laporan harian DOCX yang terorganisir per bulan di Export/[tahun]/laporan_harian/[bulan]/
 */
function generateAllDocxReports(allComprehensiveRecords, globalConfig, options = {}) {
    if (!allComprehensiveRecords || allComprehensiveRecords.length === 0) {
        console.warn('[DOCX] Tidak ada data komprehensif untuk diproses menjadi DOCX.');
        return [];
    }

    const groupedByDate = {};
    for (const record of allComprehensiveRecords) {
        let dateKey = record.hariTanggal;
        if (dateKey) {
            dateKey = normalizeDateFormat(dateKey);
            if (!groupedByDate[dateKey]) groupedByDate[dateKey] = [];
            groupedByDate[dateKey].push(record);
        }
    }

    const generatedFiles = [];
    for (const [hariTanggal, recordsForDay] of Object.entries(groupedByDate)) {
        try {
            const filePath = createSingleReportForDay(hariTanggal, recordsForDay, globalConfig, options);
            if (filePath) generatedFiles.push(filePath);
        } catch (err) {
            // lanjut ke tanggal berikutnya
        }
    }

    return generatedFiles;
}

// =============================================================================
// == 3. PEMBUATAN BERITA ACARA (XLSX) ==
// =============================================================================

async function createSingleBeritaAcara(classKey, recordsForClass, globalConfig, options = {}) {
    const [mataKuliah, kelas] = classKey;

    if (!fs.existsSync(TEMPLATE_BERITA_ACARA_PATH)) {
        throw new Error(`Template Berita Acara '${TEMPLATE_BERITA_ACARA_PATH}' tidak ditemukan.`);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(TEMPLATE_BERITA_ACARA_PATH);
    const sheet = workbook.worksheets[0];

    const firstRecord = recordsForClass[0] || {};
    const semesterName = (globalConfig.semester || {}).name || 'N/A';
    const year = options.year || (globalConfig.semester || {}).year || new Date().getFullYear();

    sheet.getCell('E5').value = firstRecord.mataKuliah || 'N/A';
    sheet.getCell('E6').value = firstRecord.sks || 'N/A';
    sheet.getCell('E8').value = firstRecord.dosen || 'N/A';

    const hariJadwal = firstRecord.day || '';
    const jamJadwal = firstRecord.jam || '';
    const e9Value = `${hariJadwal}, ${jamJadwal}`.replace(/^[, ]+|[, ]+$/g, '');
    sheet.getCell('E9').value = e9Value;

    sheet.getCell('E10').value = (firstRecord.asisten || []).join(', ');
    sheet.getCell('E11').value = semesterName;

    const startRow = 17;
    const sortedRecords = [...recordsForClass].sort((a, b) => {
        const da = parseDateIndonesian(a.hariTanggal);
        const db = parseDateIndonesian(b.hariTanggal);
        return da - db;
    });

    const recordsWithData = sortedRecords.filter(r =>
        r.status !== 'belum ada laporan' && r.status !== 'tidak ada jadwal'
    );

    for (let i = 0; i < recordsWithData.length; i++) {
        const record = recordsWithData[i];
        const currentRow = startRow + i;
        if (currentRow > sheet.rowCount) break;

        sheet.getCell(`C${currentRow}`).value = i + 1;

        const deskripsi = (record.deskripsiKegiatan || '').toLowerCase();
        const ruang = deskripsi !== 'online' ? 'LAB' : 'TEAMS';
        sheet.getCell(`D${currentRow}`).value = `${record.hariTanggal || ''}/${ruang}`;

        const jamFull = record.jam || ' - ';
        const jamSplit = jamFull.split(' - ');
        sheet.getCell(`E${currentRow}`).value = jamSplit.length > 0 ? jamSplit[0].trim() : '';
        sheet.getCell(`F${currentRow}`).value = jamSplit.length > 1 ? jamSplit[1].trim() : '';

        sheet.getCell(`G${currentRow}`).value = record.materi || '';
        sheet.getCell(`O${currentRow}`).value = '*';
        sheet.getCell(`K${currentRow}`).value = '*';
    }

    const safeMatkul = (mataKuliah || 'MataKuliah').replace(/\./g, '').replace(/\//g, '_');
    const safeKelas = (kelas || 'Kelas').replace(/\//g, '_');
    const outputFilename = `${safeMatkul}_${safeKelas}.xlsx`;

    const dirs = ensureExportDirs(year);
    const outputPath = path.join(dirs.beritaAcaraDir, outputFilename);
    await workbook.xlsx.writeFile(outputPath);

    return outputPath;
}

async function generateAllBeritaAcara(allComprehensiveRecords, globalConfig, options = {}) {
    if (!allComprehensiveRecords || allComprehensiveRecords.length === 0) {
        console.warn('[BERITA ACARA] Tidak ada data untuk diproses menjadi Berita Acara.');
        return [];
    }

    const groupedByClass = {};
    for (const record of allComprehensiveRecords) {
        const mk = record.mataKuliah;
        const kls = record.kelas;
        if (mk && kls) {
            const key = `${mk}|||${kls}`;
            if (!groupedByClass[key]) {
                groupedByClass[key] = { classKey: [mk, kls], records: [] };
            }
            groupedByClass[key].records.push(record);
        }
    }

    const generatedFiles = [];
    for (const { classKey, records } of Object.values(groupedByClass)) {
        try {
            const filePath = await createSingleBeritaAcara(classKey, records, globalConfig, options);
            if (filePath) generatedFiles.push(filePath);
        } catch (err) {
            console.error(`[BERITA ACARA] Gagal membuat berita acara untuk ${classKey.join(' - ')}:`, err.message);
        }
    }

    return generatedFiles;
}

// =============================================================================
// == 4. PEMBUATAN REKAP KEHADIRAN BULANAN (XLSX) ==
// =============================================================================

const STATUS_FILLS = {
    sunday:    { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } },
    tambahan:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF08A' } },
    diganti:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92400E' } },
    pengganti: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA5A5A5' } },
    libur:     { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEF4444' } },
};

const DATA_START = 19;
const COL_E = 5;

async function generateRekapKehadiranForMonth(month, year, globalConfig, options = {}) {
    const gridData = buildAttendanceGrid(month, year);
    if (!gridData || !gridData.assistants.length) {
        console.warn(`[REKAP KEHADIRAN] Tidak ada data asisten untuk bulan ${month}/${year}.`);
        return null;
    }

    const { monthInfo, assistants, grandTotalHari, grandTotalJam } = gridData;

    // Urutkan asisten berdasarkan NIM
    assistants.sort((a, b) => {
        const nimA = String(a.nim || '').trim();
        const nimB = String(b.nim || '').trim();

        if (nimA === '-' || nimA === '') return 1;
        if (nimB === '-' || nimB === '') return -1;

        const numA = Number(nimA);
        const numB = Number(nimB);
        if (!isNaN(numA) && !isNaN(numB)) {
            return numA - numB;
        }
        return nimA.localeCompare(nimB, undefined, { numeric: true, sensitivity: 'base' });
    });

    const daysInMonth = monthInfo.daysInMonth;
    const semesterName = (globalConfig.semester || {}).name || 'N/A';

    const COL_TOTAL_HARI = COL_E + daysInMonth;
    const COL_TOTAL_JAM = COL_TOTAL_HARI + 1;
    const lastCol = COL_TOTAL_JAM;

    if (!fs.existsSync(TEMPLATE_REKAP_PATH)) {
        throw new Error(`Template '${TEMPLATE_REKAP_PATH}' tidak ditemukan.`);
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(TEMPLATE_REKAP_PATH);
    const ws = wb.worksheets[0];

    const skValue = ws.getCell(13, 1).value || '';

    // Bersihkan merge awal
    const allMergeKeys = Object.keys(ws._merges || {});
    for (const key of allMergeKeys) {
        try { ws.unMergeCells(key); } catch (_) {}
    }
    if (ws._merges) {
        for (const key of Object.keys(ws._merges)) {
            delete ws._merges[key];
        }
    }

    // Lebar kolom
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 28;
    ws.getColumn(3).width = 14;
    ws.getColumn(4).width = 42;
    for (let d = 0; d < daysInMonth; d++) {
        ws.getColumn(COL_E + d).width = 5.5;
    }
    ws.getColumn(COL_TOTAL_HARI).width = 12;
    ws.getColumn(COL_TOTAL_JAM).width = 10;

    // Logo
    ws.mergeCells(3, 1, 5, 2);
    ws.mergeCells(3, lastCol - 1, 5, lastCol);

    if (fs.existsSync(LOGO_ITPLN_PATH)) {
        const logoId = wb.addImage({
            filename: LOGO_ITPLN_PATH,
            extension: 'png',
        });
        ws.addImage(logoId, {
            tl: { col: 0, row: 0 },
            br: { col: 2, row: 9 },
            editAs: 'oneCell'
        });
    }

    if (fs.existsSync(LOGO_SAQ_PATH)) {
        const logoId = wb.addImage({
            filename: LOGO_SAQ_PATH,
            extension: 'png',
        });
        ws.addImage(logoId, {
            tl: { col: lastCol - 2, row: 0 },
            br: { col: lastCol, row: 9 },
            editAs: 'oneCell'
        });
    }

    // Header institusi baris 3-5
    for (let r = 3; r <= 5; r++) {
        let rowVal = '';
        for (let c = 1; c <= 8; c++) {
            const v = ws.getCell(r, c).value;
            if (v !== null && v !== undefined && v !== '') {
                const s = String(typeof v === 'object' ? JSON.stringify(v) : v);
                if (s.length > String(rowVal).length) rowVal = v;
            }
        }
        ws.getCell(r, 1).value = '';
        ws.getCell(r, 2).value = '';
        ws.getCell(r, lastCol - 1).value = '';
        ws.getCell(r, lastCol).value = '';

        const cellCenter = ws.getCell(r, 3);
        cellCenter.value = rowVal;
        ws.mergeCells(r, 3, r, lastCol - 2);
        cellCenter.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cellCenter.font = { name: 'Times New Roman', size: 24, bold: true };
    }

    // Header institusi baris 6-9
    for (let r = 6; r <= 9; r++) {
        let rowVal = '';
        for (let c = 1; c <= 8; c++) {
            const v = ws.getCell(r, c).value;
            if (v !== null && v !== undefined && v !== '') {
                const s = String(typeof v === 'object' ? JSON.stringify(v) : v);
                if (s.length > String(rowVal).length) rowVal = v;
            }
        }
        ws.getCell(r, 1).value = '';
        ws.getCell(r, 2).value = '';
        ws.getCell(r, lastCol - 1).value = '';
        ws.getCell(r, lastCol).value = '';

        const cellCenter = ws.getCell(r, 3);
        cellCenter.value = rowVal;
        ws.mergeCells(r, 3, r, lastCol - 2);
        cellCenter.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cellCenter.font = { name: 'Calibri', size: 10, bold: true };
    }

    // Garis Biru Baris 10
    ws.mergeCells(10, 1, 10, lastCol);
    const blueRowStyle = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4F81BD' }
    };
    for (let c = 1; c <= lastCol; c++) {
        ws.getCell(10, c).fill = blueRowStyle;
    }

    // Judul Dokumen Baris 11-14
    for (let r = 11; r <= 14; r++) {
        ws.mergeCells(r, 1, r, lastCol);
        ws.getCell(r, 1).alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getCell(r, 1).font = { name: 'Calibri', size: 11, bold: true };
    }
    ws.getCell(11, 1).value = 'REKAPITULASI KEHADIRAN ASISTEN LABORATORIUM SOFTWARE ARCHITECTURE & QUALITY';
    ws.getCell(12, 1).value = `SEMESTER ${semesterName.toUpperCase()}`;
    ws.getCell(13, 1).value = skValue || 'SESUAI SK NOMOR : ...........................................';
    ws.getCell(14, 1).value = `PERIODE BULAN : ${monthInfo.monthName.toUpperCase()} ${year}`;

    // Header Kolom Tabel
    ws.mergeCells(16, 1, 18, 1);
    ws.getCell(16, 1).value = 'NO';
    ws.mergeCells(16, 2, 18, 2);
    ws.getCell(16, 2).value = 'NAMA MAHASISWA';
    ws.mergeCells(16, 3, 18, 3);
    ws.getCell(16, 3).value = 'NIM';
    ws.mergeCells(16, 4, 18, 4);
    ws.getCell(16, 4).value = 'MATA KULIAH';

    ws.mergeCells(16, COL_E, 16, COL_E + daysInMonth - 1);
    ws.getCell(16, COL_E).value = 'BULAN, TANGGAL DAN JAM HADIR PELAKSANAAN (DIISI JUMLAH JAM PER HARI)';

    ws.mergeCells(17, COL_E, 17, COL_E + daysInMonth - 1);
    ws.getCell(17, COL_E).value = monthInfo.monthName.toUpperCase();

    const centerAlign = { horizontal: 'center', vertical: 'middle', wrapText: true };
    const dataFont = { name: 'Calibri', size: 9 };
    const boldFont = { name: 'Calibri', size: 9, bold: true };
    const thinBorder = {
        top:    { style: 'thin', color: { argb: 'FFB0B0B0' } },
        bottom: { style: 'thin', color: { argb: 'FFB0B0B0' } },
        left:   { style: 'thin', color: { argb: 'FFB0B0B0' } },
        right:  { style: 'thin', color: { argb: 'FFB0B0B0' } },
    };

    const totalHeaderStyle = {
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } },
        alignment: { ...centerAlign, wrapText: true },
        font: boldFont,
        border: thinBorder
    };

    ws.mergeCells(16, COL_TOTAL_HARI, 18, COL_TOTAL_HARI);
    const thTitleCell = ws.getCell(16, COL_TOTAL_HARI);
    thTitleCell.value = 'TOTAL JUMLAH HARI KEHADIRAN';
    thTitleCell.style = totalHeaderStyle;

    ws.mergeCells(16, COL_TOTAL_JAM, 18, COL_TOTAL_JAM);
    const tjTitleCell = ws.getCell(16, COL_TOTAL_JAM);
    tjTitleCell.value = 'TOTAL JAM HADIR';
    tjTitleCell.style = totalHeaderStyle;

    for (let d = 0; d < daysInMonth; d++) {
        ws.getCell(18, COL_E + d).value = d + 1;
    }

    let totalDataRows = 0;
    assistants.forEach(asst => {
        totalDataRows += Math.max(asst.mataKuliahRows.length, 1);
    });
    const emptyRows = Array(totalDataRows).fill([]);
    ws.spliceRows(DATA_START, 0, ...emptyRows);

    let currentRow = DATA_START;
    for (let aIdx = 0; aIdx < assistants.length; aIdx++) {
        const asst = assistants[aIdx];
        const rowCount = Math.max(asst.mataKuliahRows.length, 1);
        const startRow = currentRow;
        const endRow = currentRow + rowCount - 1;

        if (rowCount > 1) {
            ws.mergeCells(startRow, 1, endRow, 1);
            ws.mergeCells(startRow, 2, endRow, 2);
            ws.mergeCells(startRow, 3, endRow, 3);
            ws.mergeCells(startRow, COL_TOTAL_JAM, endRow, COL_TOTAL_JAM);
        }

        const noCell = ws.getCell(startRow, 1);
        noCell.value = aIdx + 1;
        noCell.font = boldFont;
        noCell.alignment = centerAlign;
        noCell.border = thinBorder;

        const namaCell = ws.getCell(startRow, 2);
        namaCell.value = asst.nama;
        namaCell.font = { ...dataFont, bold: true };
        namaCell.alignment = { vertical: 'middle', wrapText: true };
        namaCell.border = thinBorder;

        const nimCell = ws.getCell(startRow, 3);
        nimCell.value = asst.nim;
        nimCell.font = dataFont;
        nimCell.alignment = centerAlign;
        nimCell.border = thinBorder;

        const tjCell = ws.getCell(startRow, COL_TOTAL_JAM);
        tjCell.value = asst.totalJam > 0 ? Math.round(asst.totalJam) : 0;
        tjCell.font = boldFont;
        tjCell.alignment = centerAlign;
        tjCell.border = thinBorder;

        for (let mkIdx = 0; mkIdx < rowCount; mkIdx++) {
            const r = startRow + mkIdx;
            const mkRow = asst.mataKuliahRows[mkIdx];

            const mkCell = ws.getCell(r, 4);
            mkCell.value = mkRow ? `${mkRow.name} (${mkRow.kelas})` : '';
            mkCell.font = (mkRow && mkRow.isTambahan)
                ? { ...dataFont, color: { argb: 'FF92400E' }, bold: true }
                : dataFont;
            mkCell.alignment = { vertical: 'middle', wrapText: true };
            mkCell.border = thinBorder;

            for (let d = 0; d < daysInMonth; d++) {
                const dayInfo = monthInfo.days[d];
                const col = COL_E + d;
                const cell = ws.getCell(r, col);
                const cellData = mkRow
                    ? (mkRow.cells[dayInfo.date] || { jam: 0, status: 'empty' })
                    : { jam: 0, status: dayInfo.isSunday ? 'sunday' : 'empty' };

                if (options.viewType === 'ttd' && cellData.jam > 0 && asst.ttd_image) {
                    try {
                        const cleanTtdPath = asst.ttd_image.replace(/^\/+/, '');
                        const ttdPath = path.join(PATHS.ROOT, cleanTtdPath);
                        if (fs.existsSync(ttdPath)) {
                            const ext = path.extname(ttdPath).slice(1) || 'png';
                            const imageId = wb.addImage({
                                filename: ttdPath,
                                extension: ext === 'jpg' ? 'jpeg' : ext,
                            });

                            // Hitung rasio aspek gambar untuk full width tapi proportional
                            let imgW = 100;
                            let imgH = 50;
                            if (sizeOf) {
                                try {
                                    const dims = sizeOf(ttdPath);
                                    if (dims && dims.width && dims.height) {
                                        imgW = dims.width;
                                        imgH = dims.height;
                                    }
                                } catch (e) {}
                            }

                            // Asumsi excel cell: lebar col 5.5 (~42px), tinggi baris standar (~20px)
                            const imgRatio = imgW / imgH;
                            const targetHeightPx = 42 / imgRatio;
                            const heightFraction = targetHeightPx / 20;
                            
                            // Agar posisi center vertikal (atas/bawah punya jarak yg sama)
                            const rowOffset = (1 - heightFraction) / 2;

                            ws.addImage(imageId, {
                                tl: { col: col - 1, row: r - 1 + rowOffset },
                                ext: { width: 42, height: targetHeightPx },
                                editAs: 'oneCell'
                            });
                        }
                    } catch (err) {
                        console.error('Gagal sisip TTD di excel:', err);
                    }
                } else if (cellData.jam > 0) {
                    cell.value = parseFloat(formatJam(cellData.jam));
                    cell.numFmt = '0.00';
                }

                const fill = STATUS_FILLS[cellData.status];
                if (fill) cell.fill = fill;

                if (cellData.status === 'diganti')
                    cell.font = { ...dataFont, color: { argb: 'FFFEF3C7' }, bold: true };
                else if (cellData.status === 'tambahan')
                    cell.font = { ...dataFont, color: { argb: 'FF854D0E' }, bold: true };
                else if (cellData.status === 'pengganti')
                    cell.font = { ...dataFont, bold: true };
                else if (cellData.jam > 0)
                    cell.font = { ...dataFont, color: { argb: 'FF1E3A5F' }, bold: true };
                else
                    cell.font = dataFont;

                cell.alignment = centerAlign;
                cell.border = thinBorder;
            }

            const thCell = ws.getCell(r, COL_TOTAL_HARI);
            thCell.value = (mkRow && mkRow.totalHari > 0) ? mkRow.totalHari : '';
            thCell.font = boldFont;
            thCell.alignment = centerAlign;
            thCell.border = thinBorder;

            if (mkIdx > 0) {
                ws.getCell(r, 1).border = thinBorder;
                ws.getCell(r, 2).border = thinBorder;
                ws.getCell(r, 3).border = thinBorder;
                ws.getCell(r, COL_TOTAL_JAM).border = thinBorder;
            }
        }

        currentRow = endRow + 1;
    }

    const totalRowIdx = DATA_START + totalDataRows;
    ws.getCell(totalRowIdx, COL_TOTAL_HARI).value = grandTotalHari;
    ws.getCell(totalRowIdx, COL_TOTAL_JAM).value = grandTotalJam > 0 ? Math.round(grandTotalJam) : 0;

    const dirs = ensureExportDirs(year);
    const outputFilename = `Rekap_Kehadiran_${monthInfo.monthName}_${year}.xlsx`;
    const outputPath = path.join(dirs.rekapDir, outputFilename);
    await wb.xlsx.writeFile(outputPath);

    return outputPath;
}

async function generateAllRekapKehadiran(globalConfig, options = {}) {
    const semesterInfo = globalConfig?.semester || {};
    const months = semesterInfo.months || [];
    const year = options.year || semesterInfo.year || new Date().getFullYear();

    if (!months.length) {
        console.warn('[REKAP KEHADIRAN] Info bulan semester tidak lengkap. Skip.');
        return [];
    }

    const firstMonth = months[0] || 1;
    const generatedFiles = [];
    for (const month of months) {
        try {
            const targetYear = (month < firstMonth) ? year + 1 : year;
            const filePath = await generateRekapKehadiranForMonth(month, targetYear, globalConfig, options);
            if (filePath) generatedFiles.push(filePath);
        } catch (err) {
            console.error(`[REKAP KEHADIRAN] Gagal membuat rekap untuk bulan ${month}:`, err.message);
        }
    }

    return generatedFiles;
}

// =============================================================================
// == 5. ORCHESTRATOR: GENERATE SEMUA EXPORT ==
// =============================================================================

/**
 * Menjalankan seluruh proses export terpadu ke folder:
 * Export/[tahun]/
 *   ├── rekap_kehadiran/
 *   ├── berita_acara/
 *   └── laporan_harian/[bulan]/
 */
async function generateAllExports(options = {}) {
    const globalConfig = globalConfigRepo.read();
    if (!globalConfig) {
        throw new Error('Konfigurasi global tidak ditemukan.');
    }

    const year = options.year || (globalConfig.semester || {}).year || new Date().getFullYear();
    const dirs = ensureExportDirs(year);

    console.log(`\n======================================================`);
    console.log(`>>> MEMULAI EXPORT TERPADU SAQ (TAHUN ${year}) <<<`);
    console.log(`Target Folder: ${dirs.baseYearDir}`);
    console.log(`======================================================\n`);

    // 1. Bangun data komprehensif
    const comprehensiveData = buildComprehensiveListWithPlaceholders();
    if (!comprehensiveData) {
        throw new Error('Gagal membangun data komprehensif dari database.');
    }

    // 2. Laporan Harian (DOCX)
    console.log('[1/3] Menghasilkan Laporan Harian DOCX...');
    const docxFiles = generateAllDocxReports(comprehensiveData, globalConfig, { ...options, year });
    console.log(`[1/3] Selesai. Total ${docxFiles.length} file DOCX dibuat.`);

    // 3. Berita Acara (XLSX)
    console.log('[2/3] Menghasilkan Berita Acara XLSX...');
    const beritaAcaraFiles = await generateAllBeritaAcara(comprehensiveData, globalConfig, { ...options, year });
    console.log(`[2/3] Selesai. Total ${beritaAcaraFiles.length} file Berita Acara dibuat.`);

    // 4. Rekap Kehadiran Bulanan (XLSX)
    console.log('[3/3] Menghasilkan Rekap Kehadiran XLSX...');
    const rekapFiles = await generateAllRekapKehadiran(globalConfig, { ...options, year });
    console.log(`[3/3] Selesai. Total ${rekapFiles.length} file Rekap Kehadiran dibuat.`);

    const totalFiles = docxFiles.length + beritaAcaraFiles.length + rekapFiles.length;
    console.log(`\n======================================================`);
    console.log(`>>> SEMUA PROSES EXPORT SELESAI: ${totalFiles} FILE DIBUAT <<<`);
    console.log(`======================================================\n`);

    return {
        success: true,
        year,
        exportDir: dirs.baseYearDir,
        counts: {
            docx: docxFiles.length,
            beritaAcara: beritaAcaraFiles.length,
            rekapKehadiran: rekapFiles.length,
            total: totalFiles,
        },
        files: {
            docx: docxFiles,
            beritaAcara: beritaAcaraFiles,
            rekapKehadiran: rekapFiles,
        }
    };
}

// =============================================================================
// == 6. HELPER STATISTIK & INFO DIREKTORI EXPORT ==
// =============================================================================

function countFilesInDir(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    let count = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            count += countFilesInDir(fullPath);
        } else if (entry.isFile()) {
            count++;
        }
    }
    return count;
}

function getExportStats(year) {
    const defaultYear = year || (globalConfigRepo.read()?.semester || {}).year || new Date().getFullYear();
    const dirs = getExportDirs(defaultYear);

    const rekapCount = countFilesInDir(dirs.rekapDir);
    const beritaAcaraCount = countFilesInDir(dirs.beritaAcaraDir);
    const laporanHarianCount = countFilesInDir(dirs.laporanHarianDir);

    return {
        year: defaultYear,
        baseYearDir: dirs.baseYearDir,
        hasExports: (rekapCount + beritaAcaraCount + laporanHarianCount) > 0,
        rekapCount,
        beritaAcaraCount,
        laporanHarianCount,
        totalFiles: rekapCount + beritaAcaraCount + laporanHarianCount,
    };
}

module.exports = {
    // Paths
    EXPORT_BASE_DIR,
    getExportDirs,
    ensureExportDirs,

    // Core Data Builder
    buildComprehensiveListWithPlaceholders,

    // Generators
    createSingleReportForDay,
    generateAllDocxReports,
    createSingleBeritaAcara,
    generateAllBeritaAcara,
    generateRekapKehadiranForMonth,
    generateAllRekapKehadiran,
    generateAllExports,

    // Stats & Inspection
    getExportStats,

    // Date Helpers
    getDayNameID,
    formatDateIndonesian,
    parseDateIndonesian,
    formatFilenameDate,
};

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

function resolveJsonFile(filename) {
    // Jika file belum ada di root, fallback ke folder `bak/`
    const direct = path.join(ROOT, filename);
    const bak = path.join(ROOT, 'bak', filename);
    return fs.existsSync(direct) ? direct : bak;
}

module.exports = {
    ROOT,
    CONFIG_ASISTEN:  resolveJsonFile('config_asisten.json'),
    CONFIG_GLOBAL:   resolveJsonFile('config_global.json'),
    COURSES:         resolveJsonFile('courses.json'),
    LECTURERS:       resolveJsonFile('lecturers.json'),
    SCHEDULES:       resolveJsonFile('schedules.json'),
    REPORTS:         resolveJsonFile('reports.json'),
    UPLOAD_DIR:      path.join(ROOT, 'laporan_images'),
    TTD_DIR:         path.join(ROOT, 'assets', 'ttd'),
    VIEWS_DIR:       path.join(ROOT, 'views'),
};

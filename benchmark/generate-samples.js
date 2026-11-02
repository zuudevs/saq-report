'use strict';

/**
 * Build deterministic, source-derived fixtures for zuudevs/saq-report.
 * No app database, HTTP server, external package, or random value is used.
 * Existing unrecognized files under data/sample are preserved.
 */
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_DIR = path.join(process.env.SAMPLE ?? '', 'saq-report');
const MANIFEST_PATH = path.join(process.env.RAW ?? '', 'benchmark', 'saq-report', 'manifest.json');
const ROOT = path.resolve(__dirname, '..');
const generated = [];

function requireEnvironment() {
  if (!process.env.SAMPLE || !process.env.RAW) {
    throw new Error('Set SAMPLE and RAW environment variables first. Example (PowerShell): $env:SAMPLE=<dir>; $env:RAW=<dir>; node benchmark/generate-samples.js');
  }
}

requireEnvironment();

function writeFixture(relativePath, value, meta) {
  const absolutePath = path.join(SAMPLE_DIR, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  // Keep output byte-stable: UTF-8, two-space indentation, no trailing newline.
  const serialized = JSON.stringify(value, null, 2);
  fs.writeFileSync(absolutePath, serialized, 'utf8');
  generated.push({
    path: relativePath.split(path.sep).join('/'),
    fixture_id: meta.id,
    group: meta.group,
    root_key: meta.rootKey ?? null,
    description: meta.description,
    source_files: meta.sources,
    source_behavior: meta.behavior,
    clone_input: meta.cloneInput ?? 'repository_value'
  });
}

const source = {
  paths: 'config/paths.js',
  repositories: 'repositories/index.js',
  jsonRepository: 'repositories/JsonRepository.js',
  mongoRepository: 'repositories/MongoJsonRepository.js',
  assistantRoute: 'routes/asistenRoutes.js',
  lecturerRoute: 'routes/dosenRoutes.js',
  courseRoute: 'routes/matakuliahRoutes.js',
  scheduleRoute: 'routes/jadwalRoutes.js',
  reportRoute: 'routes/laporanRoutes.js',
  settingsRoute: 'routes/settingRoutes.js',
  scheduleService: 'services/scheduleService.js',
  attendanceService: 'services/attendanceService.js'
};

const assistant = (id, fullName, shortName, phone, signature) => ({
  id,
  nama_asisten: shortName.toUpperCase(),
  nama_panjang: fullName,
  panggilan: shortName,
  no_telp: phone,
  ttd_image: signature
});

const lecturer = (id, name, title = '', email = '', phone = '', department = '') => ({
  id, name, title, email, phone, department
});

const course = (id, code, name, credits, description, department, semester) => ({
  id,
  code,
  name,
  credits,
  sks: credits,
  description,
  department,
  semester
});

const schedule = (id, courseId, lecturerId, className, day, time, pjId, assistantIds) => ({
  id,
  course_id: courseId,
  lecturer_id: lecturerId,
  class: className,
  day,
  time,
  pj_assistant_id: pjId,
  assistant_ids: assistantIds
});

const report = ({
  id,
  scheduleId,
  date,
  formattedDate,
  materi = '',
  deskripsiKegiatan = '',
  keterangan = '',
  attending = [],
  status = 'hadir',
  imagePath,
  imageFilename
}) => {
  const value = {
    id,
    schedule_id: scheduleId,
    date,
    formattedDate,
    materi,
    deskripsiKegiatan,
    keterangan,
    attending_assistant_ids: attending,
    status,
    author: 'admin@system.com',
    receivedAt: `${date}T14:00:00.000Z`
  };
  if (imagePath !== undefined) value.imagePath = imagePath;
  if (imageFilename !== undefined) value.imageFilename = imageFilename;
  return value;
};

// ---------------------------------------------------------------------------
// Persisted JSON files. Root keys/default roots follow repositories/index.js.
// ---------------------------------------------------------------------------
const a1 = assistant('ASST_000001', 'Andi Pratama', 'Andi', '081234567801', '');
const a2 = assistant('ASST_000002', 'Budi Santoso', 'Budi', '081234567802', '');
const a1Signed = { ...a1, ttd_image: '/assets/ttd/ASST_000001.png' };

writeFixture('persisted/config_asisten/ttd-empty.json', { assistants: [a1] }, {
  id: 'persisted.config_asisten.ttd-empty', group: 'persisted', rootKey: 'assistants',
  description: 'Assistant record created without an uploaded signature image.',
  sources: [source.assistantRoute, source.repositories, source.jsonRepository],
  behavior: 'routes/asistenRoutes.js creates ttd_image as an empty string when req.file is absent; repository stores the assistants root key.'
});
writeFixture('persisted/config_asisten/ttd-present.json', { assistants: [a1Signed] }, {
  id: 'persisted.config_asisten.ttd-present', group: 'persisted', rootKey: 'assistants',
  description: 'Assistant record with a signature path; image binary is deliberately excluded.',
  sources: [source.assistantRoute, source.repositories, source.jsonRepository],
  behavior: 'routes/asistenRoutes.js stores /assets/ttd/<filename> when req.file exists; fixture keeps only the JSON path.'
});

writeFixture('persisted/lecturers/optional-fields-empty.json', {
  lecturers: [lecturer('LECT_000001', 'Dosen Contoh')]
}, {
  id: 'persisted.lecturers.optional-fields-empty', group: 'persisted', rootKey: 'lecturers',
  description: 'Lecturer with optional title, email, phone, and department falling back to empty strings.',
  sources: [source.lecturerRoute, source.repositories, source.jsonRepository],
  behavior: "routes/dosenRoutes.js applies || '' to title, email, phone, and department."
});
writeFixture('persisted/lecturers/optional-fields-populated.json', {
  lecturers: [lecturer('LECT_000002', 'Dr. Citra Wulandari', 'Dr., M.Kom.', 'citra@example.test', '081234567803', 'Informatika')]
}, {
  id: 'persisted.lecturers.optional-fields-populated', group: 'persisted', rootKey: 'lecturers',
  description: 'Lecturer with the optional fields populated.',
  sources: [source.lecturerRoute, source.repositories, source.jsonRepository],
  behavior: 'Uses the lecturer object fields built by routes/dosenRoutes.js.'
});

writeFixture('persisted/courses/default-values.json', {
  courses: [course('COURSE_000001', 'CS101', 'Pemrograman Dasar', 3, '', '', null)]
}, {
  id: 'persisted.courses.default-values', group: 'persisted', rootKey: 'courses',
  description: 'Course using empty-string fallbacks and null semester.',
  sources: [source.courseRoute, source.repositories, source.jsonRepository],
  behavior: 'routes/matakuliahRoutes.js normalizes credits/sks, defaults description and department to empty strings, and semester to null.'
});
writeFixture('persisted/courses/semester-assigned.json', {
  courses: [course('COURSE_000002', 'CS202', 'Struktur Data', 3, 'Struktur data dan algoritma dasar.', 'Informatika', 4)]
}, {
  id: 'persisted.courses.semester-assigned', group: 'persisted', rootKey: 'courses',
  description: 'Course with populated descriptive fields and numeric semester.',
  sources: [source.courseRoute, source.repositories, source.jsonRepository],
  behavior: 'credits and sks have the same parsed integer value; semester is parsed as an integer.'
});

const s1 = schedule('SCHED_000001', 'COURSE_000001', 'LECT_000001', 'A', 'Senin', '13.00 - 15.30', 'ASST_000001', ['ASST_000001']);
const s2 = schedule('SCHED_000002', 'COURSE_000002', 'LECT_000002', 'B', 'Rabu', '09.00 - 11.30', 'ASST_000002', ['ASST_000002']);
const sMulti = schedule('SCHED_000003', 'COURSE_000001', 'LECT_000001', 'C', 'Jumat', '13.00 - 15.30', 'ASST_000001', ['ASST_000001', 'ASST_000002']);
writeFixture('persisted/schedules/assistant-ids-empty.json', {
  schedules: [schedule('SCHED_000004', 'COURSE_000001', 'LECT_000001', 'D', 'Selasa', '13.00 - 15.30', 'ASST_000001', [])]
}, {
  id: 'persisted.schedules.assistant-ids-empty', group: 'persisted', rootKey: 'schedules',
  description: 'Schedule with no assistant IDs in the normalized array.',
  sources: [source.scheduleRoute, source.repositories, source.jsonRepository],
  behavior: 'routes/jadwalRoutes.js normalizes assistant_ids to an array; empty array remains empty.'
});
writeFixture('persisted/schedules/assistant-ids-single.json', { schedules: [s1] }, {
  id: 'persisted.schedules.assistant-ids-single', group: 'persisted', rootKey: 'schedules',
  description: 'Schedule with exactly one assistant ID.',
  sources: [source.scheduleRoute, source.repositories, source.jsonRepository],
  behavior: 'Represents the route result after assistant_ids has been normalized to an array.'
});
writeFixture('persisted/schedules/assistant-ids-multiple.json', { schedules: [sMulti] }, {
  id: 'persisted.schedules.assistant-ids-multiple', group: 'persisted', rootKey: 'schedules',
  description: 'Schedule with more than one assistant ID.',
  sources: [source.scheduleRoute, source.repositories, source.jsonRepository],
  behavior: 'assistant_ids is an array and can contain multiple IDs.'
});

const rSingle = report({
  id: 'RPT_000001', scheduleId: s1.id, date: '2026-03-02',
  formattedDate: 'Senin, 2 Maret 2026', materi: 'Pengenalan Pemrograman',
  deskripsiKegiatan: 'Praktikum pengenalan konsep pemrograman.',
  attending: ['ASST_000001'], status: 'hadir'
});
const rMultiple = report({
  id: 'RPT_000002', scheduleId: sMulti.id, date: '2026-03-06',
  formattedDate: 'Jumat, 6 Maret 2026', materi: 'Struktur Data',
  deskripsiKegiatan: 'Praktikum struktur data.',
  attending: ['ASST_000001', 'ASST_000002'], status: 'hadir'
});
const rImage = report({
  id: 'RPT_000003', scheduleId: s1.id, date: '2026-03-09',
  formattedDate: 'Senin, 9 Maret 2026', materi: 'Implementasi Array',
  deskripsiKegiatan: 'Praktikum array dan traversal.',
  attending: ['ASST_000001', 'ASST_000002'], status: 'hadir',
  imagePath: 'laporan_images/report-000003.jpg',
  imageFilename: 'report-000003.jpg'
});
const rEmpty = report({
  id: 'RPT_000004', scheduleId: s1.id, date: '2026-03-16',
  formattedDate: 'Senin, 16 Maret 2026', materi: '',
  deskripsiKegiatan: '', attending: [], status: 'hadir'
});
writeFixture('persisted/reports/single-attendee.json', [rSingle], {
  id: 'persisted.reports.single-attendee', group: 'persisted', rootKey: null,
  description: 'Root-array report with one attending assistant.',
  sources: [source.reportRoute, source.repositories, source.jsonRepository],
  behavior: 'Report create maps attending_assistant_ids through toArray(); reports repository has array root.'
});
writeFixture('persisted/reports/multiple-attendees.json', [rMultiple], {
  id: 'persisted.reports.multiple-attendees', group: 'persisted', rootKey: null,
  description: 'Root-array report with multiple attending assistant IDs.',
  sources: [source.reportRoute, source.repositories, source.jsonRepository],
  behavior: 'attending_assistant_ids is normalized into an array by toArray().'
});
writeFixture('persisted/reports/multiple-attendees-image.json', [rImage], {
  id: 'persisted.reports.multiple-attendees-image', group: 'persisted', rootKey: null,
  description: 'Report with multiple attendants and image metadata; image bytes are excluded.',
  sources: [source.reportRoute, source.repositories, source.jsonRepository],
  behavior: 'When req.file exists, report includes imagePath and imageFilename. Binary upload is not part of JSON parsing.'
});
writeFixture('persisted/reports/empty-attendee-edge-case.json', [rEmpty], {
  id: 'persisted.reports.empty-attendee-edge-case', group: 'persisted', rootKey: null,
  description: 'Edge case accepted by the route helper if an empty value reaches the handler; not a normal validated form submission.',
  sources: [source.reportRoute, source.repositories, source.jsonRepository],
  behavior: 'toArray(undefined or empty value) returns []; the fixture is explicitly marked as an edge case, not normal user flow.'
});

const fallbackConfig = {
  semester: { id: 'SEM_001', name: '', year: 2026, months: [1, 2, 3, 4, 5, 6] },
  system: { cron_time: '15:00', group_id: '', version: '1.0.0', last_updated: '2026-01-01' },
  bot_messages: {
    greetings: ['Terima kasih atas laporannya!'],
    emojis: ['👍', '✨', '🙏', '😊']
  }
};
const populatedConfig = {
  semester: { id: 'SEM_2026_GENAP', name: 'Semester Genap 2025/2026', year: 2026, months: [1, 2, 3, 4, 5, 6] },
  system: { cron_time: '15:00', group_id: '120000000000000000@g.us', version: '1.0.0', last_updated: '2026-03-01' },
  bot_messages: {
    greetings: ['Terima kasih atas laporannya!', 'Laporan sudah diterima.'],
    emojis: ['👍', '✨']
  }
};
writeFixture('persisted/config_global/fallback-config.json', fallbackConfig, {
  id: 'persisted.config_global.fallback-config', group: 'persisted', rootKey: null,
  description: 'Global configuration using documented defaults/fallbacks with fixed dates.',
  sources: [source.settingsRoute, source.repositories, source.jsonRepository],
  behavior: 'Follows default semester, system, and bot_messages fallback values; dynamic date is fixed for deterministic fixture generation.'
});
writeFixture('persisted/config_global/populated-config.json', populatedConfig, {
  id: 'persisted.config_global.populated-config', group: 'persisted', rootKey: null,
  description: 'Global configuration with semester, system, greetings, and emojis populated.',
  sources: [source.settingsRoute, source.repositories, source.jsonRepository],
  behavior: 'Matches the newConfig structure in routes/settingRoutes.js; last_updated is fixed rather than generated at run time.'
});

// ---------------------------------------------------------------------------
// Service output fixtures: deterministic materializations of shapes/branches
// in scheduleService.js and attendanceService.js. No DB or app bootstrap.
// ---------------------------------------------------------------------------
const baseAssistants = [a1, a2];
const baseLecturers = [
  lecturer('LECT_000001', 'Dosen Contoh', 'M.Kom.', 'dosen@example.test', '081234567811', 'Informatika'),
  lecturer('LECT_000002', 'Dosen Kedua', 'M.T.', 'dosen2@example.test', '081234567812', 'Informatika')
];
const baseCourses = [
  course('COURSE_000001', 'CS101', 'Pemrograman Dasar', 3, 'Dasar pemrograman.', 'Informatika', 2),
  course('COURSE_000002', 'CS202', 'Struktur Data', 2, 'Struktur data.', 'Informatika', 4)
];
const baseSchedules = [s1, s2];

function enrichSchedule(item, { courses, lecturers, assistants }) {
  return {
    ...item,
    course: courses.find((x) => x.id === item.course_id) ?? null,
    lecturer: lecturers.find((x) => x.id === item.lecturer_id) ?? null,
    pjAssistant: assistants.find((x) => x.id === item.pj_assistant_id) ?? null,
    assistants: assistants.filter((x) => item.assistant_ids.includes(x.id))
  };
}
function enrichReport(item, { schedules, courses, lecturers, assistants }) {
  const matchingSchedule = schedules.find((x) => x.id === item.schedule_id) ?? null;
  const matchingCourse = matchingSchedule
    ? (courses.find((x) => x.id === matchingSchedule.course_id) ?? null)
    : null;
  const matchingLecturer = matchingSchedule
    ? (lecturers.find((x) => x.id === matchingSchedule.lecturer_id) ?? null)
    : null;
  const attendingAssistants = assistants.filter((x) => item.attending_assistant_ids?.includes(x.id));
  return {
    ...item,
    schedule: matchingSchedule,
    course: matchingCourse,
    lecturer: matchingLecturer,
    attendingAssistants
  };
}

const resolvedSchedule = enrichSchedule(s1, {
  courses: baseCourses, lecturers: baseLecturers, assistants: baseAssistants
});
const unresolvedSchedule = enrichSchedule({
  ...s1,
  id: 'SCHED_000099',
  course_id: 'COURSE_MISSING',
  lecturer_id: 'LECT_MISSING',
  pj_assistant_id: 'ASST_MISSING',
  assistant_ids: ['ASST_MISSING']
}, { courses: baseCourses, lecturers: baseLecturers, assistants: baseAssistants });
writeFixture('service-output/enriched-schedules/resolved-relations.json', [resolvedSchedule], {
  id: 'service-output.enriched-schedules.resolved-relations', group: 'service-output', rootKey: null,
  description: 'Enriched schedule with all relations resolved.',
  sources: [source.scheduleService],
  behavior: 'Mirrors enrichSchedule(): spreads schedule and appends course, lecturer, pjAssistant, and assistants.'
});
writeFixture('service-output/enriched-schedules/unresolved-relations.json', [unresolvedSchedule], {
  id: 'service-output.enriched-schedules.unresolved-relations', group: 'service-output', rootKey: null,
  description: 'Enriched schedule where referenced course, lecturer, and assistants are absent.',
  sources: [source.scheduleService],
  behavior: 'Mirrors enrichSchedule() null fallbacks and empty assistants result.'
});

const resolvedReport = enrichReport(rSingle, {
  schedules: baseSchedules, courses: baseCourses, lecturers: baseLecturers, assistants: baseAssistants
});
const missingScheduleReport = enrichReport({
  ...rSingle,
  id: 'RPT_000099',
  schedule_id: 'SCHED_MISSING',
  attending_assistant_ids: ['ASST_000001']
}, { schedules: baseSchedules, courses: baseCourses, lecturers: baseLecturers, assistants: baseAssistants });
writeFixture('service-output/enriched-reports/resolved-relations.json', [resolvedReport], {
  id: 'service-output.enriched-reports.resolved-relations', group: 'service-output', rootKey: null,
  description: 'Enriched report with schedule, course, lecturer, and attendee relations.',
  sources: [source.scheduleService],
  behavior: 'Mirrors getEnrichedReports(): spreads report and appends schedule, course, lecturer, attendingAssistants.'
});
writeFixture('service-output/enriched-reports/missing-schedule.json', [missingScheduleReport], {
  id: 'service-output.enriched-reports.missing-schedule', group: 'service-output', rootKey: null,
  description: 'Enriched report with a missing schedule relation.',
  sources: [source.scheduleService],
  behavior: 'Mirrors getEnrichedReports() null fallbacks when the schedule and derived course/lecturer cannot be found.'
});

function buildAttendanceGridFixture(month, year, assistants, schedules, courses, reports) {
  const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthDays = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateObj = new Date(year, month - 1, day);
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayOfWeek = dateObj.getDay();
    monthDays.push({ day, date, dayOfWeek, dayName: dayNames[dayOfWeek] || '', isSunday: dayOfWeek === 0 });
  }
  const courseMap = Object.fromEntries(courses.map((x) => [x.id, x]));
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const monthReports = reports.filter((x) => x.date && x.date.startsWith(monthPrefix));
  const reportLookup = {};
  for (const item of monthReports) reportLookup[`${item.schedule_id}__${item.date}`] = item;
  const weekdayMap = { Senin: 1, Selasa: 2, Rabu: 3, Kamis: 4, Jumat: 5, Sabtu: 6, Minggu: 0 };
  const emptyMonthCells = () => Object.fromEntries(monthDays.map((d) => [d.date, {
    jam: 0, status: d.isSunday ? 'sunday' : 'empty'
  }]));
  const sksToJam = (sks) => (!sks || sks <= 0 ? 0 : Math.round(((sks * 50) / 60) * 100) / 100);

  const assistantRows = assistants.map((person) => {
    const assignedSchedules = schedules.filter((item) => item.pj_assistant_id === person.id || (item.assistant_ids || []).includes(person.id));
    const assignedScheduleIds = new Set(assignedSchedules.map((x) => x.id));
    const scheduledRows = assignedSchedules.map((sched) => {
      const c = courseMap[sched.course_id] || {};
      const sks = c.sks ?? c.credits ?? 0;
      const jam = sksToJam(sks);
      const schedWeekday = weekdayMap[sched.day];
      const cells = emptyMonthCells();
      let totalHari = 0;
      for (const dayInfo of monthDays) {
        if (dayInfo.isSunday) continue;
        const found = reportLookup[`${sched.id}__${dayInfo.date}`];
        if (found) {
          const attending = found.attending_assistant_ids || [];
          if (attending.includes(person.id)) {
            cells[dayInfo.date] = { jam, status: found.status === 'pengganti' ? 'pengganti' : 'normal' };
            totalHari += 1;
          } else {
            cells[dayInfo.date] = { jam: 0, status: 'diganti' };
          }
          continue;
        }
        if (dayInfo.dayOfWeek !== schedWeekday) continue;
      }
      return {
        scheduleId: sched.id,
        name: c.name || 'N/A',
        kelas: sched.class,
        sks,
        jam,
        day: sched.day,
        cells,
        totalHari,
        isTambahan: false
      };
    });

    const tambahanMap = {};
    for (const dayInfo of monthDays) {
      if (dayInfo.isSunday) continue;
      for (const found of monthReports.filter((x) => x.date === dayInfo.date)) {
        if (assignedScheduleIds.has(found.schedule_id)) continue;
        const attending = found.attending_assistant_ids || [];
        if (!attending.includes(person.id)) continue;
        const sched = schedules.find((x) => x.id === found.schedule_id);
        if (!sched) continue;
        const c = courseMap[sched.course_id] || {};
        const sks = c.sks ?? c.credits ?? 0;
        const jam = sksToJam(sks);
        if (!tambahanMap[sched.id]) {
          tambahanMap[sched.id] = {
            scheduleId: sched.id,
            name: c.name || 'N/A',
            kelas: sched.class,
            sks,
            jam,
            day: sched.day,
            cells: emptyMonthCells(),
            totalHari: 0,
            isTambahan: true
          };
        }
        tambahanMap[sched.id].cells[dayInfo.date] = { jam, status: 'tambahan' };
        tambahanMap[sched.id].totalHari += 1;
      }
    }

    const allRows = [...scheduledRows, ...Object.values(tambahanMap)];
    const totalJam = Math.round(allRows.reduce((sum, row) => sum + Object.values(row.cells).reduce((total, cell) => total + (cell.jam || 0), 0), 0) * 100) / 100;
    const totalHariKehadiran = allRows.reduce((sum, row) => sum + row.totalHari, 0);
    return {
      id: person.id,
      nama: person.nama_panjang || person.nama_asisten,
      nim: person.NIM || '-',
      ttd_image: person.ttd_image || '',
      mataKuliahRows: allRows,
      totalJam,
      totalHariKehadiran
    };
  });

  return {
    monthInfo: { month, year, monthName: monthNames[month - 1] || '', daysInMonth: monthDays.length, days: monthDays },
    assistants: assistantRows,
    grandTotalHari: assistantRows.reduce((sum, x) => sum + x.totalHariKehadiran, 0),
    grandTotalJam: Math.round(assistantRows.reduce((sum, x) => sum + x.totalJam, 0) * 100) / 100
  };
}

const attendanceReports = [
  report({ id: 'RPT_GRID_001', scheduleId: s1.id, date: '2026-03-02', formattedDate: 'Senin, 2 Maret 2026', attending: ['ASST_000001', 'ASST_000002'], status: 'hadir' }),
  report({ id: 'RPT_GRID_002', scheduleId: s1.id, date: '2026-03-09', formattedDate: 'Senin, 9 Maret 2026', attending: ['ASST_000002'], status: 'hadir' }),
  report({ id: 'RPT_GRID_003', scheduleId: s1.id, date: '2026-03-16', formattedDate: 'Senin, 16 Maret 2026', attending: ['ASST_000001'], status: 'pengganti' }),
  report({ id: 'RPT_GRID_004', scheduleId: s2.id, date: '2026-03-04', formattedDate: 'Rabu, 4 Maret 2026', attending: ['ASST_000001'], status: 'hadir' })
];
const attendanceGrid = buildAttendanceGridFixture(3, 2026, baseAssistants, baseSchedules, baseCourses, attendanceReports);
writeFixture('service-output/attendance-grid/monthly-mixed-statuses.json', attendanceGrid, {
  id: 'service-output.attendance-grid.monthly-mixed-statuses', group: 'service-output', rootKey: null,
  description: 'Monthly attendance grid covering empty, Sunday, normal, diganti, tambahan, and pengganti cell states.',
  sources: [source.attendanceService],
  behavior: 'Deterministic materialization of buildAttendanceGrid() return schema and its emitted cell status branches. LIBUR is not included because the current builder does not emit it.'
});

// /settings/update-raw receives raw_json as a string and parses that string.
// This file's bytes are the JSON text passed in raw_json (not a wrapper object).
writeFixture('route-input/settings-update-raw.json', populatedConfig, {
  id: 'route-input.settings-update-raw', group: 'route-input', rootKey: null,
  description: 'JSON text that the /settings/update-raw handler receives inside req.body.raw_json.',
  sources: [source.settingsRoute],
  behavior: 'The route calls JSON.parse(raw_json), rejects non-object/array/null roots, then writes the parsed configuration.'
});

fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
const manifest = {
  schema_version: '1.0.0',
  repository: 'https://github.com/zuudevs/saq-report',
  branch: 'main',
  generated_by: 'scripts/generate-samples.js',
  determinism: {
    ids: 'fixed',
    dates: 'fixed at 2026-03',
    timestamps: 'fixed ISO strings',
    random_values: false,
    image_binaries: false
  },
  notes: [
    'Fixture values are synthetic; field names, object shapes, root keys, and scenario branches are derived from the source files listed per fixture.',
    'Persisted fixtures use the JSON file root shape expected by JsonRepository. root_key records the key extracted by JsonRepository.read().',
    'Service-output fixtures are deterministic materializations of the output schema/branch logic in the referenced service implementation; they do not initialize MongoDB or invoke app startup.',
    'Image scenarios include only imagePath/imageFilename or a signature path. Binary image data is not included.',
    'The empty-attendee report is an edge case that can reach the handler through toArray(); it is not represented as a normal form submission.'
  ],
  fixtures: generated.sort((a, b) => a.path.localeCompare(b.path))
};
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

console.log(`Generated ${generated.length} deterministic fixtures in ${path.relative(ROOT, SAMPLE_DIR)}.`);
console.log(`Manifest: ${MANIFEST_PATH}`);

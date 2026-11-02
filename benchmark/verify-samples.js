'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_DIR = path.join(process.env.SAMPLE ?? '', 'saq-report');
const MANIFEST_PATH = path.join(process.env.RAW ?? '', 'benchmark', 'saq-report', 'manifest.json');

function requireEnvironment() {
  if (!process.env.SAMPLE || !process.env.RAW) {
    throw new Error('Set SAMPLE and RAW environment variables first. Example (PowerShell): $env:SAMPLE=<dir>; $env:RAW=<dir>; node benchmark/verify-samples.js');
  }
}

function collectJsonFiles(dir, prefix = '') {
  const collected = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) collected.push(...collectJsonFiles(absolute, relative));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) collected.push(relative);
  }
  return collected;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  requireEnvironment();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const entries = manifest.fixtures;
  assert(Array.isArray(entries) && entries.length > 0, 'Manifest has no fixtures array.');

  const manifestPaths = entries.map((entry) => entry.path).sort();
  const manifestIds = entries.map((entry) => entry.fixture_id);
  assert(new Set(manifestPaths).size === manifestPaths.length, 'Duplicate fixture path in manifest.');
  assert(new Set(manifestIds).size === manifestIds.length, 'Duplicate fixture_id in manifest.');

  const actualPaths = collectJsonFiles(SAMPLE_DIR).sort();
  const actualSet = new Set(actualPaths);
  const missingManifestPaths = manifestPaths.filter((fixturePath) => !actualSet.has(fixturePath));
  assert(missingManifestPaths.length === 0, `Manifest references missing fixture(s): ${missingManifestPaths.join(', ')}`);

  for (const entry of entries) {
    const absolute = path.join(SAMPLE_DIR, entry.path);
    assert(fs.existsSync(absolute), `Missing fixture: ${entry.path}`);
    const value = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    if (entry.root_key) {
      assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${entry.path}: expected object wrapper.`);
      assert(Object.hasOwn(value, entry.root_key), `${entry.path}: missing root key ${entry.root_key}.`);
    }
    if (entry.group === 'service-output' && entry.fixture_id.startsWith('service-output.enriched-schedules')) {
      assert(Array.isArray(value), `${entry.path}: enriched schedules must be array root.`);
      for (const item of value) {
        for (const key of ['course', 'lecturer', 'pjAssistant', 'assistants']) assert(Object.hasOwn(item, key), `${entry.path}: missing ${key}.`);
      }
    }
    if (entry.group === 'service-output' && entry.fixture_id.startsWith('service-output.enriched-reports')) {
      assert(Array.isArray(value), `${entry.path}: enriched reports must be array root.`);
      for (const item of value) {
        for (const key of ['schedule', 'course', 'lecturer', 'attendingAssistants']) assert(Object.hasOwn(item, key), `${entry.path}: missing ${key}.`);
      }
    }
    if (entry.fixture_id === 'service-output.attendance-grid.monthly-mixed-statuses') {
      assert(value && value.monthInfo && Array.isArray(value.monthInfo.days), 'Attendance grid monthInfo is invalid.');
      assert(Array.isArray(value.assistants), 'Attendance grid assistants must be an array.');
      const statuses = new Set();
      for (const person of value.assistants) {
        for (const row of person.mataKuliahRows) {
          for (const cell of Object.values(row.cells)) statuses.add(cell.status);
        }
      }
      const expected = ['diganti', 'empty', 'normal', 'pengganti', 'sunday', 'tambahan'];
      assert(expected.every((status) => statuses.has(status)), `Attendance grid missing one of: ${expected.join(', ')}.`);
      assert(!statuses.has('libur'), 'Current attendance builder does not emit libur; remove fabricated status.');
    }
  }

  const extraCount = actualPaths.length - entries.length;
  console.log(`Verified ${entries.length} manifest fixture(s); ${extraCount} additional JSON file(s) will be benchmarked as unclassified.`);
  console.log('All fixture JSON parses; manifest paths, root keys, and selected service-output shapes are consistent.');
}

try {
  main();
} catch (error) {
  console.error(`[verify-samples] ${error.message}`);
  process.exitCode = 1;
}

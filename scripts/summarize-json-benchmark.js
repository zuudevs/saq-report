'use strict';

const fs = require('node:fs');
const path = require('node:path');

const inputFile = process.argv[2];
if (!inputFile) {
    console.error('Pemakaian: node scripts/summarize-json-benchmark.js <hasil.jsonl>');
    process.exit(2);
}

const resolvedInput = path.resolve(inputFile);
if (!fs.existsSync(resolvedInput)) {
    console.error('File benchmark tidak ditemukan:', resolvedInput);
    process.exit(2);
}

const rows = fs.readFileSync(resolvedInput, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new Error('JSONL tidak valid pada baris ' + (index + 1) + ': ' + error.message);
        }
    });

function percentile(sorted, fraction) {
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function stats(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((total, value) => total + value, 0);
    return {
        count: values.length,
        min: sorted[0],
        median: percentile(sorted, 0.5),
        mean: sum / values.length,
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1],
    };
}

function throughputMiBPerSecond(records, elapsedField) {
    const bytes = records.reduce((total, row) => total + row.payload_bytes, 0);
    const elapsedNs = records.reduce((total, row) => total + row[elapsedField], 0);
    if (elapsedNs <= 0) return null;
    return bytes / (elapsedNs / 1e9) / (1024 * 1024);
}

const comparable = rows.filter((row) => row.comparable === true);
const allZeElapsed = rows
    .map((row) => row.ze_json && row.ze_json.elapsed_ns)
    .filter(Number.isFinite);
const allNativeElapsed = rows
    .map((row) => row.json_parse && row.json_parse.elapsed_ns)
    .filter(Number.isFinite);
const speedupRatios = comparable
    .map((row) => row.ze_json_speedup_ratio)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_file: path.basename(resolvedInput),
    total_payloads: rows.length,
    comparable_payloads: comparable.length,
    unsupported_or_non_object_payloads: rows.filter(
        (row) => !row.ze_json || row.ze_json.supported_root_and_size !== true
    ).length,
    ze_json_failures: rows.filter((row) => row.ze_json && row.ze_json.ok === false).length,
    json_parse_failures: rows.filter((row) => row.json_parse && row.json_parse.ok === false).length,
    elapsed_ns: {
        ze_json_all_attempts: stats(allZeElapsed),
        json_parse_all_attempts: stats(allNativeElapsed),
        ze_json_comparable: stats(comparable.map((row) => row.ze_json.elapsed_ns)),
        json_parse_comparable: stats(comparable.map((row) => row.json_parse.elapsed_ns)),
    },
    comparable_median_speedup_ratio: speedupRatios.length
        ? percentile(speedupRatios, 0.5)
        : null,
    approximate_throughput_mib_per_second: {
        ze_json_comparable: throughputMiBPerSecond(
            comparable.map((row) => ({
                ...row,
                ze_json_elapsed_ns: row.ze_json.elapsed_ns,
            })),
            'ze_json_elapsed_ns'
        ),
        json_parse_comparable: throughputMiBPerSecond(
            comparable.map((row) => ({
                ...row,
                json_parse_elapsed_ns: row.json_parse.elapsed_ns,
            })),
            'json_parse_elapsed_ns'
        ),
    },
    interpretation:
        'Rasio adalah pembagian waktu JSON.parse dengan waktu ze_json. Parser membandingkan pekerjaan berbeda: ze_json scan + tape/Session setup, sedangkan JSON.parse membangun nilai JavaScript lengkap. Gunakan hasil sebagai metrik tahap parsing, bukan bukti kesetaraan workload end-to-end.',
};

const outputFile = resolvedInput.replace(/\.jsonl$/i, '') + '.summary.json';
fs.writeFileSync(outputFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log('Ringkasan disimpan ke:', outputFile);
console.log(JSON.stringify({
    total_payloads: summary.total_payloads,
    comparable_payloads: summary.comparable_payloads,
    ze_json_failures: summary.ze_json_failures,
    json_parse_failures: summary.json_parse_failures,
    comparable_median_speedup_ratio: summary.comparable_median_speedup_ratio,
}, null, 2));

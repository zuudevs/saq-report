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

let rawRows;
try {
    rawRows = fs.readFileSync(resolvedInput, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line, index) => {
            try {
                return JSON.parse(line);
            } catch (error) {
                throw new Error('JSONL tidak valid pada baris ' + (index + 1) + ': ' + error.message);
            }
        });
} catch (error) {
    console.error(error.message);
    process.exit(2);
}

function percentile(sorted, fraction) {
    if (sorted.length === 0) return null;
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function medianOfSorted(sorted) {
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

function stats(values) {
    const valid = values.filter(Number.isFinite);
    if (valid.length === 0) return null;

    const sorted = [...valid].sort((a, b) => a - b);
    const sum = valid.reduce((total, value) => total + value, 0);
    return {
        count: valid.length,
        min: sorted[0],
        median: medianOfSorted(sorted),
        mean: sum / valid.length,
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1],
    };
}

// Tukey upper fence is diagnostic only: suspected outliers remain in all metrics.
function countHighOutliers(values) {
    const valid = values.filter(Number.isFinite);
    if (valid.length < 4) return 0;

    const sorted = [...valid].sort((a, b) => a - b);
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const upperFence = q3 + 1.5 * (q3 - q1);
    return valid.filter((value) => value > upperFence).length;
}

function throughputMiBPerSecond(records, elapsedField) {
    const bytes = records.reduce((total, row) => total + row.payload_bytes, 0);
    const elapsedNs = records.reduce(
        (total, row) => total + row[elapsedField],
        0
    );
    if (elapsedNs <= 0) return null;
    return bytes / (elapsedNs / 1e9) / (1024 * 1024);
}

function groupPayloads(records) {
    const groups = new Map();

    for (const row of records) {
        const workload = typeof row.workload === 'string' && row.workload
            ? row.workload
            : 'unlabelled';
        const hash = row.payload_sha256 || 'missing-hash:' + row.payload_bytes;
        const key = workload + '|' + hash;

        if (!groups.has(key)) {
            groups.set(key, {
                workload,
                payload_sha256: row.payload_sha256 || null,
                payload_bytes: row.payload_bytes,
                rows: [],
            });
        }
        groups.get(key).rows.push(row);
    }

    return [...groups.values()]
        .map((group) => {
            const groupRows = group.rows;
            const comparableRows = groupRows.filter((row) => row.comparable === true);
            const zeValues = groupRows
                .map((row) => row.ze_json && row.ze_json.elapsed_ns)
                .filter(Number.isFinite);
            const nativeValues = groupRows
                .map((row) => row.json_parse && row.json_parse.elapsed_ns)
                .filter(Number.isFinite);
            const ratios = comparableRows
                .map((row) => row.ze_json_speedup_ratio)
                .filter((value) => Number.isFinite(value) && value > 0);
            const zeStats = stats(zeValues);
            const nativeStats = stats(nativeValues);
            // Never report a comparative ratio when either parser failed. Raw
            // attempt latencies remain visible in ze_json/json_parse below.
            const zeComparableStats = stats(
                comparableRows.map((row) => row.ze_json && row.ze_json.elapsed_ns)
            );
            const nativeComparableStats = stats(
                comparableRows.map((row) => row.json_parse && row.json_parse.elapsed_ns)
            );
            const zeErrors = [...new Set(groupRows
                .filter((row) => row.ze_json && row.ze_json.ok === false)
                .map((row) => row.ze_json.error_message)
                .filter((message) => typeof message === 'string' && message.length > 0))].slice(0, 3);
            const nativeErrors = [...new Set(groupRows
                .filter((row) => row.json_parse && row.json_parse.ok === false)
                .map((row) => row.json_parse.error_message)
                .filter((message) => typeof message === 'string' && message.length > 0))].slice(0, 3);

            return {
                workload: group.workload,
                payload_sha256: group.payload_sha256,
                payload_bytes: group.payload_bytes,
                samples: groupRows.length,
                comparable_samples: comparableRows.length,
                ze_json_all_attempts: zeStats,
                json_parse_all_attempts: nativeStats,
                ze_json_comparable: zeComparableStats,
                json_parse_comparable: nativeComparableStats,
                median_per_request_speedup_ratio: stats(ratios)?.median ?? null,
                speedup_ratio_from_medians: zeComparableStats && nativeComparableStats &&
                    zeComparableStats.median > 0
                    ? nativeComparableStats.median / zeComparableStats.median
                    : null,
                suspected_high_outliers: {
                    ze_json: countHighOutliers(zeValues),
                    json_parse: countHighOutliers(nativeValues),
                    method: 'Tukey upper fence (Q3 + 1.5 * IQR); records are retained',
                },
                ze_json_failures: groupRows.filter(
                    (row) => row.ze_json && row.ze_json.ok === false
                ).length,
                json_parse_failures: groupRows.filter(
                    (row) => row.json_parse && row.json_parse.ok === false
                ).length,
                parser_error_samples: {
                    ze_json: zeErrors,
                    json_parse: nativeErrors,
                },
            };
        })
        .sort((a, b) =>
            a.workload.localeCompare(b.workload) ||
            a.payload_bytes - b.payload_bytes
        );
}

// Backward compatibility: older JSONL rows without benchmark_phase are measured rows.
const warmupRows = rawRows.filter((row) => row.benchmark_phase === 'warmup');
const rows = rawRows.filter((row) => row.benchmark_phase !== 'warmup');
const comparable = rows.filter((row) => row.comparable === true);

const allZeElapsed = rows
    .map((row) => row.ze_json && row.ze_json.elapsed_ns)
    .filter(Number.isFinite);
const allNativeElapsed = rows
    .map((row) => row.json_parse && row.json_parse.elapsed_ns)
    .filter(Number.isFinite);
const speedupRatios = comparable
    .map((row) => row.ze_json_speedup_ratio)
    .filter((value) => Number.isFinite(value) && value > 0);

const zeComparableStats = stats(comparable.map((row) => row.ze_json.elapsed_ns));
const nativeComparableStats = stats(comparable.map((row) => row.json_parse.elapsed_ns));
const meanLogRatio = speedupRatios.length
    ? speedupRatios.reduce((total, value) => total + Math.log(value), 0) / speedupRatios.length
    : null;

const orderCounts = rows.reduce((counts, row) => {
    const order = row.execution_order || 'not-recorded';
    counts[order] = (counts[order] || 0) + 1;
    return counts;
}, {});
const parserErrorSamples = {
    ze_json: [...new Set(rows
        .filter((row) => row.ze_json && row.ze_json.ok === false)
        .map((row) => row.ze_json.error_message)
        .filter((message) => typeof message === 'string' && message.length > 0))].slice(0, 10),
    json_parse: [...new Set(rows
        .filter((row) => row.json_parse && row.json_parse.ok === false)
        .map((row) => row.json_parse.error_message)
        .filter((message) => typeof message === 'string' && message.length > 0))].slice(0, 10),
};

const summary = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    source_file: path.basename(resolvedInput),
    total_payloads: rows.length,
    warmup_payloads_excluded: warmupRows.length,
    logged_payloads_including_warmup: rawRows.length,
    comparable_payloads: comparable.length,
    unsupported_or_non_object_payloads: rows.filter(
        (row) => !row.ze_json || row.ze_json.supported_root_and_size !== true
    ).length,
    ze_json_failures: rows.filter((row) => row.ze_json && row.ze_json.ok === false).length,
    json_parse_failures: rows.filter((row) => row.json_parse && row.json_parse.ok === false).length,
    execution_order_counts: orderCounts,
    parser_error_samples: parserErrorSamples,
    elapsed_ns: {
        ze_json_all_measurements: stats(allZeElapsed),
        json_parse_all_measurements: stats(allNativeElapsed),
        ze_json_comparable: zeComparableStats,
        json_parse_comparable: nativeComparableStats,
    },
    comparable_median_speedup_ratio: stats(speedupRatios)?.median ?? null,
    speedup_ratio_from_comparable_medians:
        zeComparableStats && nativeComparableStats && zeComparableStats.median > 0
            ? nativeComparableStats.median / zeComparableStats.median
            : null,
    comparable_geometric_mean_speedup_ratio: meanLogRatio === null
        ? null
        : Math.exp(meanLogRatio),
    approximate_throughput_mib_per_second: {
        ze_json_comparable: throughputMiBPerSecond(
            comparable.map((row) => ({
                payload_bytes: row.payload_bytes,
                ze_json_elapsed_ns: row.ze_json.elapsed_ns,
            })),
            'ze_json_elapsed_ns'
        ),
        json_parse_comparable: throughputMiBPerSecond(
            comparable.map((row) => ({
                payload_bytes: row.payload_bytes,
                json_parse_elapsed_ns: row.json_parse.elapsed_ns,
            })),
            'json_parse_elapsed_ns'
        ),
    },
    payload_summaries: groupPayloads(rows),
    interpretation:
        'Rasio adalah waktu JSON.parse dibagi waktu ze_json; nilai di atas 1 berarti ze_json lebih cepat pada metrik itu. Median untuk sampel genap adalah rata-rata dua nilai tengah. Payload warm-up dikecualikan dari metrik terukur, tetapi tidak dihapus dari JSONL. Urutan parser digilir dan dicatat. Tukey upper fence hanya menandai dugaan outlier; semua sampel tetap dipertahankan. ze_json mengukur scan + tape/Session setup on-demand, sedangkan JSON.parse membangun nilai JavaScript lengkap, jadi workload tidak identik.',
};

const outputFile = resolvedInput.replace(/\.jsonl$/i, '') + '.summary.json';
fs.writeFileSync(outputFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log('Ringkasan disimpan ke:', outputFile);
console.log(JSON.stringify({
    total_payloads: summary.total_payloads,
    warmup_payloads_excluded: summary.warmup_payloads_excluded,
    comparable_payloads: summary.comparable_payloads,
    ze_json_failures: summary.ze_json_failures,
    json_parse_failures: summary.json_parse_failures,
    median_per_request_speedup_ratio: summary.comparable_median_speedup_ratio,
    speedup_ratio_from_comparable_medians: summary.speedup_ratio_from_comparable_medians,
    payload_summaries: summary.payload_summaries.map((item) => ({
        workload: item.workload,
        payload_bytes: item.payload_bytes,
        samples: item.samples,
        comparable_samples: item.comparable_samples,
        median_per_request_speedup_ratio: item.median_per_request_speedup_ratio,
        speedup_ratio_from_medians: item.speedup_ratio_from_medians,
        suspected_high_outliers: item.suspected_high_outliers,
    })),
}, null, 2));

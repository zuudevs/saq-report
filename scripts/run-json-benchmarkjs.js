'use strict';

const Benchmark = require('benchmark');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'output', 'benchmarks', 'json-parser-benchmarkjs');
const ZE_PACKAGE = path.join(ROOT, 'node_modules', '@zuudevs', 'ze-json', 'package.json');

function options(argv) {
    const o = { maxTime: 5, minSamples: 10, warmup: 20, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') { o.help = true; continue; }
        const eq = arg.indexOf('=');
        const key = eq < 0 ? arg : arg.slice(0, eq);
        const inline = eq < 0 ? undefined : arg.slice(eq + 1);
        const value = inline === undefined ? argv[++i] : inline;
        if (key === '--max-time') o.maxTime = Number(value);
        else if (key === '--min-samples') o.minSamples = Number(value);
        else if (key === '--warmup') o.warmup = Number(value);
        else if (key === '--iterations') {
            throw new Error('--iterations tidak berlaku untuk Benchmark.js; gunakan --max-time dan --min-samples.');
        } else throw new Error('Opsi tidak dikenal: ' + key + '. Gunakan --help.');
    }
    if (!o.help && (!Number.isFinite(o.maxTime) || o.maxTime < 0.5)) {
        throw new Error('--max-time harus angka >= 0.5 detik.');
    }
    if (!o.help && (!Number.isInteger(o.minSamples) || o.minSamples < 5)) {
        throw new Error('--min-samples harus bilangan bulat >= 5.');
    }
    if (!o.help && (!Number.isInteger(o.warmup) || o.warmup < 0)) {
        throw new Error('--warmup harus bilangan bulat >= 0.');
    }
    return o;
}

function payloads() {
    const small = { source: 'saq-report-benchmark', kind: 'small', ok: true, revision: 1 };
    const medium = {
        source: 'saq-report-benchmark', kind: 'medium', ok: true,
        numbers: Array.from({ length: 100 }, (_, i) => i),
        items: Array.from({ length: 50 }, (_, i) => ({
            id: i + 1, code: 'ITEM-' + String(i + 1).padStart(3, '0'),
            active: i % 2 === 0, score: (i * 7) % 101,
            description: 'Deterministic benchmark item payload.',
        })),
    };
    const large = {
        source: 'saq-report-benchmark', kind: 'large', ok: true,
        records: Array.from({ length: 500 }, (_, i) => ({
            id: i + 1, code: 'RECORD-' + String(i + 1).padStart(4, '0'),
            course: 'COURSE-' + String((i % 45) + 1).padStart(3, '0'),
            active: i % 3 !== 0, score: (i * 17) % 101,
            description: 'Deterministic larger payload for parser benchmark.',
        })),
    };
    return [
        { name: 'small', body: JSON.stringify(small) },
        { name: 'medium', body: JSON.stringify(medium) },
        { name: 'large', body: JSON.stringify(large) },
    ].map(p => ({
        name: p.name, body: p.body, bytes: Buffer.byteLength(p.body, 'utf8'),
        sha256: crypto.createHash('sha256').update(p.body, 'utf8').digest('hex'),
    }));
}

function median(xs) {
    const a = xs.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function pct(xs, p) {
    const a = xs.filter(Number.isFinite).slice().sort((x, y) => x - y);
    return a.length ? a[Math.max(0, Math.ceil(a.length * p) - 1)] : null;
}
function fmt(x) { return Number.isFinite(x) ? x.toFixed(3) : 'n/a'; }
function revision() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch { return 'unknown'; }
}

async function main() {
    const opt = options(process.argv.slice(2));
    if (opt.help) {
        console.log(
            'Benchmark.js langsung, tanpa server HTTP.\n' +
            'npm run benchmark:json -- [--max-time 5] [--min-samples 10] [--warmup 20]\n' +
            '--max-time: batas waktu per benchmark dalam detik; --min-samples: jumlah sampel Benchmark.js;\n' +
            '--warmup: pemanggilan eksplisit per parser dan payload sebelum pengukuran.'
        );
        return;
    }
    if (Number(process.versions.node.split('.')[0]) < 24) {
        throw new Error('Memerlukan Node.js >= 24 untuk WebAssembly memory64.');
    }
    if (!fs.existsSync(ZE_PACKAGE)) throw new Error('Paket @zuudevs/ze-json tidak ditemukan; jalankan npm install.');
    const zeInfo = JSON.parse(fs.readFileSync(ZE_PACKAGE, 'utf8'));
    const benchInfo = JSON.parse(fs.readFileSync(require.resolve('benchmark/package.json'), 'utf8'));
    const { ZeJson } = await import('@zuudevs/ze-json');
    const inputs = payloads();
    const expected = { small: 71, medium: 5731, large: 73084 };
    for (const p of inputs) {
        if (p.bytes !== expected[p.name]) throw new Error('Ukuran payload ' + p.name + ' berubah menjadi ' + p.bytes + ' byte.');
        JSON.parse(p.body);
    }

    const ze = await ZeJson.load();
    let sinkJSON = null;
    let sinkDoc = null;
    let failed = false;
    const byName = new Map();
    const byWorkload = new Map();
    try {
        // Preflight dan warm-up di luar pengukuran.
        for (const p of inputs) {
            ze.openDocument(p.body);
            JSON.parse(p.body);
            for (let i = 0; i < opt.warmup; i++) {
                if (i % 2 === 0) {
                    sinkJSON = JSON.parse(p.body);
                    sinkDoc = ze.openDocument(p.body);
                } else {
                    sinkDoc = ze.openDocument(p.body);
                    sinkJSON = JSON.parse(p.body);
                }
            }
        }

        const suite = new Benchmark.Suite('SAQ JSON parser benchmark');
        inputs.forEach((p, index) => {
            byWorkload.set(p.name, {
                workload: p.name, payload_bytes: p.bytes, payload_sha256: p.sha256,
                json_parse: null, ze_json_scan: null, ratio_of_median_times: null,
            });
            const addJSON = () => {
                const name = p.name + ' / JSON.parse';
                byName.set(name, { workload: p.name, kind: 'json_parse' });
                suite.add(name, {
                    fn: function () { sinkJSON = JSON.parse(p.body); },
                    maxTime: opt.maxTime, minSamples: opt.minSamples,
                    onError: event => { failed = true; console.error('[Benchmark.js] ' + name + ': ' + String(event.target.error)); },
                });
            };
            const addZe = () => {
                const name = p.name + ' / ze_json openDocument';
                byName.set(name, { workload: p.name, kind: 'ze_json_scan' });
                suite.add(name, {
                    fn: function () { sinkDoc = ze.openDocument(p.body); },
                    maxTime: opt.maxTime, minSamples: opt.minSamples,
                    onError: event => { failed = true; console.error('[Benchmark.js] ' + name + ': ' + String(event.target.error)); },
                });
            };
            // JSON-first untuk small/large, ze-first untuk medium.
            if (index % 2 === 0) { addJSON(); addZe(); } else { addZe(); addJSON(); }
        });

        console.log('[Benchmark.js] Node ' + process.version +
            ' | ze_json ' + zeInfo.version + ' | Benchmark.js ' + benchInfo.version);
        console.log('[Benchmark.js] maxTime=' + opt.maxTime + 's; minSamples=' + opt.minSamples +
            '; warm-up=' + opt.warmup + ' per parser/payload');
        inputs.forEach(p => console.log('[Benchmark.js] ' + p.name + ': ' + p.bytes + ' byte; sha256=' + p.sha256));
        console.log('[Benchmark.js] Memulai 6 benchmark langsung; server HTTP tidak diperlukan.\n');

        suite
            .on('cycle', event => {
                const target = event.target;
                const meta = byName.get(target.name);
                if (!meta) return;
                const samples = Array.isArray(target.stats.sample)
                    ? target.stats.sample.map(seconds => seconds * 1e6) : [];
                const stat = {
                    status: target.error ? 'error' : 'ok',
                    operations_per_second: Number.isFinite(target.hz) ? target.hz : null,
                    mean_us_per_op: Number.isFinite(target.stats.mean) ? target.stats.mean * 1e6 : null,
                    median_us_per_op: median(samples),
                    p95_cycle_sample_us_per_op: pct(samples, 0.95),
                    rme_percent: Number.isFinite(target.stats.rme) ? target.stats.rme : null,
                    sample_count: samples.length,
                    operation_count: Number.isFinite(target.count) ? target.count : null,
                    elapsed_seconds: Number.isFinite(target.times.elapsed) ? target.times.elapsed : null,
                    cycle_samples_us_per_op: samples,
                    error_message: target.error ? String(target.error) : null,
                };
                const row = byWorkload.get(meta.workload);
                row[meta.kind] = stat;
                console.log('  ' + meta.workload.padEnd(7) + ' ' + meta.kind.padEnd(13) +
                    ' median=' + fmt(stat.median_us_per_op) + ' µs/op' +
                    ' mean=' + fmt(stat.mean_us_per_op) + ' µs/op' +
                    ' RME=' + (stat.rme_percent === null ? 'n/a' : stat.rme_percent.toFixed(2) + '%') +
                    ' samples=' + stat.sample_count);
                if (stat.status !== 'ok') failed = true;
            })
            .on('error', event => {
                failed = true;
                console.error('[Benchmark.js] Suite error: ' + String(event.target && event.target.error));
            })
            .on('complete', () => {
                const rows = Array.from(byWorkload.values());
                rows.forEach(row => {
                    if (row.json_parse && row.ze_json_scan &&
                        row.json_parse.status === 'ok' && row.ze_json_scan.status === 'ok' &&
                        row.json_parse.median_us_per_op > 0 && row.ze_json_scan.median_us_per_op > 0) {
                        row.ratio_of_median_times =
                            row.json_parse.median_us_per_op / row.ze_json_scan.median_us_per_op;
                    }
                });

                const time = new Date().toISOString();
                const stamp = time.replace(/[:.]/g, '-');
                const base = path.join(OUT, 'benchmarkjs-' + stamp + '-' + process.pid);
                const cpu = os.cpus();
                const result = {
                    schema_version: 1, benchmark_engine: 'Benchmark.js', generated_at: time,
                    git_revision: revision(),
                    runtime: {
                        node: process.version, platform: process.platform, platform_release: os.release(),
                        architecture: process.arch, cpu_model: cpu[0] ? cpu[0].model : null,
                        logical_cpu_count: cpu.length,
                    },
                    libraries: { ze_json: zeInfo.version, benchmark_js: benchInfo.version },
                    configuration: {
                        max_time_seconds: opt.maxTime, min_samples: opt.minSamples,
                        explicit_warmup_calls_per_parser_per_workload: opt.warmup,
                    },
                    methodology: {
                        json_parse: 'JSON.parse(payloadText), materialisasi seluruh nilai JavaScript',
                        ze_json: 'ze.openDocument(payloadText): encodeInto + reset arena + create_session + scanner/tape/session',
                        timing: 'Benchmark.js cycle samples; tidak ada HTTP/Express dalam jalur terukur',
                        comparability: 'Operasi sengaja berbeda cakupan; rasio hanya berlaku untuk operasi yang tercatat, bukan bukti kerja parser setara.',
                    },
                    payloads: inputs.map(p => ({ workload: p.name, bytes: p.bytes, sha256: p.sha256 })),
                    results: rows,
                    valid: !failed && rows.length === 3 && rows.every(r =>
                        r.json_parse && r.ze_json_scan &&
                        r.json_parse.status === 'ok' && r.ze_json_scan.status === 'ok'),
                    sinks: { last_json_root_type: sinkJSON === null ? null : typeof sinkJSON, last_ze_document_retained: sinkDoc !== null },
                };

                fs.mkdirSync(OUT, { recursive: true });
                fs.writeFileSync(base + '.json', JSON.stringify(result, null, 2) + '\n', 'utf8');
                let md =
                    '# Benchmark.js: JSON.parse vs ze_json\n\n' +
                    '- Generated: ' + time + '\n- Git revision: ' + result.git_revision +
                    '\n- Node: ' + process.version + '\n- Platform: ' + process.platform + ' ' + os.release() +
                    '\n- CPU: ' + (result.runtime.cpu_model || 'unknown') +
                    '\n- @zuudevs/ze-json: ' + zeInfo.version + '\n- Benchmark.js: ' + benchInfo.version +
                    '\n- maxTime: ' + opt.maxTime + ' s; minSamples: ' + opt.minSamples +
                    '; explicit warm-up: ' + opt.warmup + '\n- Valid: ' + result.valid +
                    '\n\n| Workload | Bytes | JSON.parse median (µs/op) | JSON RME | ze_json median (µs/op) | ze RME | Ratio of medians (JSON / ze) |\n' +
                    '|---|---:|---:|---:|---:|---:|---:|\n';
                rows.forEach(r => {
                    md += '| ' + r.workload + ' | ' + r.payload_bytes +
                        ' | ' + fmt(r.json_parse ? r.json_parse.median_us_per_op : null) +
                        ' | ' + (r.json_parse && r.json_parse.rme_percent !== null ? r.json_parse.rme_percent.toFixed(2) + '%' : 'n/a') +
                        ' | ' + fmt(r.ze_json_scan ? r.ze_json_scan.median_us_per_op : null) +
                        ' | ' + (r.ze_json_scan && r.ze_json_scan.rme_percent !== null ? r.ze_json_scan.rme_percent.toFixed(2) + '%' : 'n/a') +
                        ' | ' + (Number.isFinite(r.ratio_of_median_times) ? r.ratio_of_median_times.toFixed(3) + '×' : 'n/a') +
                        ' |\n';
                });
                md += '\n## Metodologi dan batasan\n\n' +
                    '- JSON.parse membangun seluruh nilai JavaScript; ze_json mengukur openDocument termasuk encodeInto, reset arena, pemanggilan WASM, scanner, tape, dan persiapan Session.\n' +
                    '- Karena cakupan operasi berbeda, rasio tidak membuktikan bahwa kedua parser menyelesaikan pekerjaan identik.\n' +
                    '- RME menunjukkan variasi Benchmark.js. Urutan dibalik untuk workload medium, tetapi efek urutan dan drift clock tidak sepenuhnya dihilangkan.\n' +
                    '- cycle_samples_us_per_op adalah sampel siklus Benchmark.js, bukan 300 request HTTP atau observasi per-request.\n';
                fs.writeFileSync(base + '.md', md, 'utf8');

                console.log('\n[Benchmark.js] Valid: ' + result.valid);
                console.log('[Benchmark.js] JSON: ' + base + '.json');
                console.log('[Benchmark.js] Markdown: ' + base + '.md');
                if (!result.valid) process.exitCode = 1;
                ze.close();
            });

        suite.run({ async: true, queued: true });
    } catch (error) {
        ze.close();
        throw error;
    }
}

main().catch(error => {
    console.error('[Benchmark.js] Gagal:', error.message);
    process.exitCode = 1;
});

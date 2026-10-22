'use strict';

const DEFAULT_URL = process.env.JSON_BENCHMARK_URL || 'http://127.0.0.1:3100/benchmark';

function readOptions(argv) {
    const options = {
        url: DEFAULT_URL,
        iterations: 100,
        warmup: 20,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        const [rawKey, inlineValue] = arg.split('=', 2);
        const key = rawKey;
        const value = inlineValue !== undefined ? inlineValue : argv[i + 1];

        if (key === '--url') options.url = value;
        else if (key === '--iterations') options.iterations = Number(value);
        else if (key === '--warmup') options.warmup = Number(value);
        else continue;

        if (inlineValue === undefined) i += 1;
    }

    if (options.help) return options;

    if (!Number.isInteger(options.iterations) || options.iterations < 1) {
        throw new Error('--iterations harus bilangan bulat >= 1.');
    }
    if (!Number.isInteger(options.warmup) || options.warmup < 0) {
        throw new Error('--warmup harus bilangan bulat >= 0.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(options.url);
    } catch {
        throw new Error('URL benchmark tidak valid: ' + options.url);
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('URL benchmark harus menggunakan HTTP atau HTTPS.');
    }

    return options;
}

function createPayloads() {
    const small = {
        source: 'saq-report-benchmark',
        kind: 'small',
        ok: true,
        revision: 1,
    };

    const medium = {
        source: 'saq-report-benchmark',
        kind: 'medium',
        ok: true,
        numbers: Array.from({ length: 100 }, (_, index) => index),
        items: Array.from({ length: 50 }, (_, index) => ({
            id: index + 1,
            code: 'ITEM-' + String(index + 1).padStart(3, '0'),
            active: index % 2 === 0,
            score: (index * 7) % 101,
            description: 'Deterministic benchmark item payload.',
        })),
    };

    const large = {
        source: 'saq-report-benchmark',
        kind: 'large',
        ok: true,
        records: Array.from({ length: 500 }, (_, index) => ({
            id: index + 1,
            code: 'RECORD-' + String(index + 1).padStart(4, '0'),
            course: 'COURSE-' + String((index % 45) + 1).padStart(3, '0'),
            active: index % 3 !== 0,
            score: (index * 17) % 101,
            description: 'Deterministic larger payload for parser benchmark.',
        })),
    };

    return [
        { name: 'small', body: JSON.stringify(small) },
        { name: 'medium', body: JSON.stringify(medium) },
        { name: 'large', body: JSON.stringify(large) },
    ];
}

// Fixed-seed shuffle makes workload order reproducible while interleaving sizes.
function shuffleDeterministically(items) {
    let seed = 0xC0FFEE;
    const shuffled = [...items];

    function nextRandom() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    }

    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(nextRandom() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

async function sendRequest(url, scenario, phase) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-benchmark-phase': phase,
            'x-benchmark-workload': scenario.name,
        },
        body: scenario.body,
    });

    const body = await response.text();
    if (!response.ok) {
        throw new Error(
            'Request ' + phase + '/' + scenario.name + ' gagal: HTTP ' +
            response.status + ' — ' + body.slice(0, 300)
        );
    }
}

function printHelp() {
    console.log(`Pemakaian:
  npm run benchmark:json -- [opsi]

Opsi:
  --url URL          Endpoint benchmark (default: ${DEFAULT_URL})
  --iterations N     Sampel terukur per payload (default: 100)
  --warmup N         Warm-up per payload, tidak masuk statistik (default: 20)
  --help             Tampilkan bantuan

Runner menguji payload small, medium, dan large. Pastikan server benchmark sudah berjalan.
URL dapat diubah melalui environment variable JSON_BENCHMARK_URL.`);
}

async function main() {
    const options = readOptions(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    const payloads = createPayloads();
    const totalWarmups = payloads.length * options.warmup;
    const totalMeasurements = payloads.length * options.iterations;

    console.log('[JSON benchmark] Endpoint: ' + options.url);
    console.log('[JSON benchmark] Payload:');
    for (const payload of payloads) {
        console.log(
            '  ' + payload.name + ': ' +
            Buffer.byteLength(payload.body, 'utf8') + ' byte'
        );
    }
    console.log(
        '[JSON benchmark] Warm-up: ' + totalWarmups +
        '; pengukuran: ' + totalMeasurements +
        ' (' + options.iterations + ' per payload).'
    );

    // Warm each workload; the server records these rows as warm-up, and the
    // summary script excludes them from measured statistics.
    for (const payload of payloads) {
        for (let i = 0; i < options.warmup; i += 1) {
            await sendRequest(options.url, payload, 'warmup');
        }
    }

    const schedule = [];
    for (const payload of payloads) {
        for (let i = 0; i < options.iterations; i += 1) {
            schedule.push(payload);
        }
    }

    const shuffledSchedule = shuffleDeterministically(schedule);
    for (let i = 0; i < shuffledSchedule.length; i += 1) {
        await sendRequest(options.url, shuffledSchedule[i], 'measurement');
        if ((i + 1) % 50 === 0 || i + 1 === shuffledSchedule.length) {
            console.log(
                '[JSON benchmark] Pengukuran: ' + (i + 1) +
                '/' + shuffledSchedule.length
            );
        }
    }

    console.log('[JSON benchmark] Selesai. Buat ringkasan dari file JSONL terbaru.');
    console.log(
        '  $run = Get-ChildItem .\\output\\benchmarks\\json-parser\\*.jsonl | ' +
        'Sort-Object LastWriteTime -Descending | Select-Object -First 1'
    );
    console.log('  npm run summarize:json-benchmark -- "$($run.FullName)"');
}

main().catch((error) => {
    console.error('[JSON benchmark] Gagal:', error.message);
    process.exitCode = 1;
});

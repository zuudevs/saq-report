'use strict';

/**
 * Deterministic JSON parser benchmark for source-derived SAQ Report fixtures.
 * Uses only Node.js built-in modules. No database or HTTP server is started.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_DIR = path.join(process.env.SAMPLE, 'saq-report');
const MANIFEST_PATH = path.join(process.env.RAW, 'benchmark', 'saq-report', 'manifest.json');
const DEFAULTS = {
  input: SAMPLE_DIR,
  out: path.join(process.env.RAW, 'benchmark', 'saq-report'),
  samples: 100,
  warmupMs: 100,
  sampleTargetMs: 20,
  maxOperationsPerSample: 1_000_000,
  modes: ['parse-only', 'file-read-parse', 'json-clone']
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, modes: [...DEFAULTS.modes] };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const [rawKey, ...valueParts] = arg.replace(/^--/, '').split('=');
    const value = valueParts.join('=');
    if (!valueParts.length) throw new Error(`Expected --key=value, got: ${arg}`);
    switch (rawKey) {
      case 'input': options.input = value; break;
      case 'out': options.out = value; break;
      case 'samples': options.samples = positiveInteger(value, rawKey); break;
      case 'warmup': options.warmupMs = nonNegativeNumber(value, rawKey); break;
      case 'sample-target-ms': options.sampleTargetMs = positiveNumber(value, rawKey); break;
      case 'max-operations-per-sample': options.maxOperationsPerSample = positiveInteger(value, rawKey); break;
      case 'modes': {
        const allowed = new Set(DEFAULTS.modes);
        options.modes = value.split(',').map((item) => item.trim()).filter(Boolean);
        if (!options.modes.length || options.modes.some((mode) => !allowed.has(mode))) {
          throw new Error(`--modes must be a comma-separated subset of: ${[...allowed].join(', ')}`);
        }
        break;
      }
      default: throw new Error(`Unknown option: --${rawKey}`);
    }
  }
  if (!options.samples) throw new Error('--samples must be greater than zero');
  return options;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}
function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be greater than zero`);
  return parsed;
}
function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} must be zero or greater`);
  return parsed;
}

function printHelp() {
  console.log(`SAQ Report JSON Parser Benchmark

Usage:
  node scripts/benchmark-json.js [options]

Options:
  --input=data/sample                Directory scanned recursively for .json files
  --out=benchmark/results            Output directory, or a .json file path
  --samples=100                      Number of measured batches per mode and fixture
  --warmup=100                       Warm-up duration per mode and fixture (ms)
  --sample-target-ms=20              Target duration for each measured batch (ms)
  --max-operations-per-sample=1000000 Safety cap for operations in one batch
  --modes=parse-only,file-read-parse,json-clone
                                      Select one or more measurement modes
  --help                             Show this help

Examples:
  node scripts/benchmark-json.js
  node scripts/benchmark-json.js --samples=10 --warmup=50 --sample-target-ms=5
  node scripts/benchmark-json.js --modes=parse-only,file-read-parse
`);
}

function walkJsonFiles(directory) {
  if (!fs.existsSync(directory)) throw new Error(`Input directory does not exist: ${directory}`);
  const found = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) found.push(absolute);
    }
  };
  walk(directory);
  return found.sort((a, b) => path.relative(directory, a).split(path.sep).join('/').localeCompare(
    path.relative(directory, b).split(path.sep).join('/')
  ));
}

function loadFixtureManifest(inputDirectory) {
  const manifestPath = MANIFEST_PATH;
  if (!fs.existsSync(manifestPath)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
  const map = new Map();
  for (const entry of entries) {
    map.set(path.resolve(inputDirectory, entry.path), entry);
  }
  return map;
}

function rootType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function extractRepositoryValue(parsed, fixture) {
  if (fixture && fixture.root_key) {
    // JsonRepository.read(): json[rootKey] ?? defaultValue; array repositories default to [].
    return parsed[fixture.root_key] ?? [];
  }
  return parsed;
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    heap_used: usage.heapUsed,
    heap_total: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    array_buffers: usage.arrayBuffers
  };
}

function elapsedNs(start) {
  return Number(process.hrtime.bigint() - start);
}

// Timed loops are intentionally specialized per mode so there is no callback dispatch
// inside the per-operation hot loop. The final parsed value is retained after timing.
let blackhole;
function runBatch(mode, operations, context) {
  let last;
  const started = process.hrtime.bigint();

  if (mode === 'parse-only') {
    for (let i = 0; i < operations; i += 1) last = JSON.parse(context.raw);
  } else if (mode === 'file-read-parse') {
    for (let i = 0; i < operations; i += 1) {
      const raw = fs.readFileSync(context.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      last = extractRepositoryValue(parsed, context.fixture);
    }
  } else if (mode === 'json-clone') {
    for (let i = 0; i < operations; i += 1) {
      last = JSON.parse(JSON.stringify(context.cloneValue));
    }
  } else {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const durationNs = elapsedNs(started);
  blackhole = last;
  return { operations, elapsed_ns: durationNs, ns_per_operation: durationNs / operations };
}

function calibrateOperations(mode, context, targetNs, maxOperations) {
  let operations = 1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = runBatch(mode, operations, context);
    if (result.elapsed_ns >= targetNs || operations >= maxOperations) return operations;
    const estimated = Math.ceil((targetNs / Math.max(result.elapsed_ns, 1)) * operations * 0.85);
    operations = Math.min(maxOperations, Math.max(operations + 1, estimated));
  }
  return operations;
}

function runWarmup(mode, operations, context, warmupMs) {
  if (warmupMs <= 0) return;
  const deadline = performance.now() + warmupMs;
  do {
    runBatch(mode, operations, context);
  } while (performance.now() < deadline);
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return null;
  // Nearest-rank percentile, with 1-based rank.
  const rank = Math.max(1, Math.ceil(percentileValue * sortedValues.length));
  return sortedValues[Math.min(rank - 1, sortedValues.length - 1)];
}

function calculateStats(samples, payloadBytes) {
  const values = samples.map((sample) => sample.ns_per_operation).sort((a, b) => a - b);
  const count = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / count;
  const totalOperations = samples.reduce((sum, sample) => sum + sample.operations, 0);
  const totalElapsedNs = samples.reduce((sum, sample) => sum + sample.elapsed_ns, 0);
  const totalBytes = payloadBytes * totalOperations;
  const seconds = totalElapsedNs / 1e9;
  return {
    total_operations: totalOperations,
    total_elapsed_ns: totalElapsedNs,
    latency: {
      min_ns: values[0],
      max_ns: values[count - 1],
      mean_ns: mean,
      median_ns: percentile(values, 0.50),
      p95_ns: percentile(values, 0.95),
      p99_ns: percentile(values, 0.99),
      stddev_ns: Math.sqrt(variance)
    },
    throughput: {
      operations_per_second: seconds > 0 ? totalOperations / seconds : null,
      mib_per_second: seconds > 0 ? (totalBytes / (1024 * 1024)) / seconds : null,
      data_processed_bytes: totalBytes
    },
    samples
  };
}

function measureMode(mode, context, options, payloadBytes) {
  const targetNs = options.sampleTargetMs * 1e6;
  const operationsPerSample = calibrateOperations(
    mode, context, targetNs, options.maxOperationsPerSample
  );
  runWarmup(mode, operationsPerSample, context, options.warmupMs);

  const samples = [];
  for (let index = 0; index < options.samples; index += 1) {
    const result = runBatch(mode, operationsPerSample, context);
    const seconds = result.elapsed_ns / 1e9;
    const bytes = payloadBytes * result.operations;
    samples.push({
      sample: index + 1,
      operations: result.operations,
      elapsed_ns: result.elapsed_ns,
      ns_per_operation: result.ns_per_operation,
      operations_per_second: seconds > 0 ? result.operations / seconds : null,
      mib_per_second: seconds > 0 ? (bytes / (1024 * 1024)) / seconds : null
    });
  }
  const stats = calculateStats(samples, payloadBytes);
  return {
    operations_per_sample: operationsPerSample,
    warmup_ms: options.warmupMs,
    target_sample_ms: options.sampleTargetMs,
    ...stats
  };
}

function getGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').trim();
  } catch {
    return null;
  }
}

function aggregateMode(results, mode) {
  let totalOperations = 0;
  let totalElapsedNs = 0;
  let totalBytes = 0;
  for (const result of results) {
    const measurement = result.measurements?.[mode];
    if (!measurement) continue;
    totalOperations += measurement.total_operations;
    totalElapsedNs += measurement.total_elapsed_ns;
    totalBytes += measurement.throughput.data_processed_bytes;
  }
  const seconds = totalElapsedNs / 1e9;
  return {
    total_operations: totalOperations,
    total_elapsed_ns: totalElapsedNs,
    data_processed_bytes: totalBytes,
    aggregate_operations_per_second: seconds > 0 ? totalOperations / seconds : null,
    aggregate_mib_per_second: seconds > 0 ? (totalBytes / (1024 * 1024)) / seconds : null
  };
}

function aggregateByGroup(results, modes) {
  const groups = {};
  for (const result of results) {
    const group = result.group || 'unclassified';
    if (!groups[group]) groups[group] = {};
  }
  for (const group of Object.keys(groups)) {
    const groupResults = results.filter((result) => (result.group || 'unclassified') === group);
    for (const mode of modes) groups[group][mode] = aggregateMode(groupResults, mode);
  }
  return groups;
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();

  const inputDirectory = SAMPLE_DIR;
  const files = walkJsonFiles(inputDirectory);
  if (!files.length) throw new Error(`No .json files found under ${inputDirectory}`);
  const fixtureManifest = loadFixtureManifest(inputDirectory);

  const startedAt = new Date();
  const startedMemory = memorySnapshot();
  const errors = [];
  const results = [];
  let validFixtures = 0;
  let totalPayloadBytes = 0;

  console.log(`Found ${files.length} JSON fixture(s) in ${SAMPLE_DIR}.`);
  console.log(`Modes: ${options.modes.join(', ')} | samples: ${SAMPLE_DIR} | target: ${options.sampleTargetMs} ms`);

  for (const filePath of files) {
    const relativePath = path.relative(inputDirectory, filePath).split(path.sep).join('/');
    const fixture = fixtureManifest.get(filePath) || {
      fixture_id: relativePath.replace(/\.json$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '.'),
      group: 'unclassified',
      root_key: null,
      description: 'JSON file discovered under input directory; no manifest entry.'
    };

    let raw;
    let parsed;
    let fileStats;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
      fileStats = fs.statSync(filePath);
      parsed = JSON.parse(raw);
    } catch (error) {
      const entry = {
        fixture_id: fixture.fixture_id,
        file: relativePath,
        stage: 'load-or-validate',
        error_name: error.name,
        message: error.message
      };
      errors.push(entry);
      results.push({
        fixture_id: fixture.fixture_id,
        group: fixture.group,
        file: relativePath,
        status: 'error',
        error: entry
      });
      console.error(`  [INVALID] ${relativePath}: ${error.message}`);
      continue;
    }

    validFixtures += 1;
    totalPayloadBytes += fileStats.size;
    const repositoryValue = extractRepositoryValue(parsed, fixture);
    const cloneRaw = JSON.stringify(repositoryValue);
    const cloneBytes = Buffer.byteLength(cloneRaw, 'utf8');
    const context = { raw, filePath, fixture, cloneValue: repositoryValue };
    const memoryBefore = memorySnapshot();
    const measurements = {};

    console.log(`  [RUN] ${relativePath} (${fileStats.size} bytes)`);
    try {
      for (const mode of options.modes) {
        const bytes = mode === 'json-clone' ? cloneBytes : fileStats.size;
        measurements[mode] = measureMode(mode, context, options, bytes);
      }
      const memoryAfter = memorySnapshot();
      results.push({
        fixture_id: fixture.fixture_id,
        group: fixture.group,
        description: fixture.description,
        file: relativePath,
        status: 'success',
        payload: {
          size_bytes: fileStats.size,
          sha256: crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
          root_type: rootType(parsed),
          repository_value_type: rootType(repositoryValue),
          root_key: fixture.root_key ?? null,
          clone_input_size_bytes: cloneBytes
        },
        source: {
          files: fixture.source_files || [],
          behavior: fixture.source_behavior || null
        },
        measurements,
        memory: {
          heap_used_before: memoryBefore.heap_used,
          heap_used_after: memoryAfter.heap_used,
          heap_used_delta: memoryAfter.heap_used - memoryBefore.heap_used,
          heap_total_before: memoryBefore.heap_total,
          heap_total_after: memoryAfter.heap_total,
          rss_before: memoryBefore.rss,
          rss_after: memoryAfter.rss,
          external_before: memoryBefore.external,
          external_after: memoryAfter.external,
          array_buffers_before: memoryBefore.array_buffers,
          array_buffers_after: memoryAfter.array_buffers
        }
      });
    } catch (error) {
      const entry = {
        fixture_id: fixture.fixture_id,
        file: relativePath,
        stage: 'measurement',
        error_name: error.name,
        message: error.message
      };
      errors.push(entry);
      results.push({
        fixture_id: fixture.fixture_id,
        group: fixture.group,
        file: relativePath,
        status: 'error',
        error: entry,
        measurements
      });
      console.error(`  [ERROR] ${relativePath}: ${error.message}`);
    }
  }

  const finishedAt = new Date();
  const finishedMemory = memorySnapshot();
  const successful = results.filter((result) => result.status === 'success');
  const runId = `baseline-${startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const summary = {
    total_fixtures: files.length,
    successful_fixtures: successful.length,
    failed_fixtures: results.length - successful.length,
    total_operations_by_mode: Object.fromEntries(options.modes.map((mode) => [mode, aggregateMode(successful, mode).total_operations])),
    modes: Object.fromEntries(options.modes.map((mode) => [mode, aggregateMode(successful, mode)])),
    by_group: aggregateByGroup(successful, options.modes)
  };
  const report = {
    schema_version: '1.0.0',
    metadata: {
      benchmark_name: 'saq-report-json-baseline',
      benchmark_version: '1.0.0',
      run_id: runId,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Number(finishedAt - startedAt),
      source: {
        repository: 'https://github.com/zuudevs/saq-report',
        branch: 'main',
        git_commit: getGitCommit()
      },
      runtime: {
        runtime: 'Node.js',
        node_version: process.version,
        v8_version: process.versions.v8,
        platform: process.platform,
        architecture: process.arch,
        cpu_model: os.cpus()[0]?.model || null,
        logical_cores: os.cpus().length,
        total_memory_bytes: os.totalmem()
      },
      parser: {
        name: 'JSON.parse',
        implementation: 'V8 native JSON parser',
        clone_implementation: 'JSON.parse(JSON.stringify(value))'
      },
      configuration: {
        input_directory: SAMPLE_DIR,
        modes: options.modes,
        warmup_ms: options.warmupMs,
        samples: options.samples,
        sample_target_ms: options.sampleTargetMs,
        max_operations_per_sample: options.maxOperationsPerSample,
        concurrency: 1,
        execution_mode: 'sequential',
        percentile_method: 'nearest-rank over batch-normalized ns_per_operation',
        standard_deviation: 'population standard deviation over batch-normalized ns_per_operation'
      },
      process_memory: {
        heap_used_before: startedMemory.heap_used,
        heap_used_after: finishedMemory.heap_used,
        heap_used_delta: finishedMemory.heap_used - startedMemory.heap_used,
        rss_before: startedMemory.rss,
        rss_after: finishedMemory.rss
      }
    },
    dataset: {
      directory: SAMPLE_DIR,
      files_discovered: files.length,
      files_valid: validFixtures,
      files_invalid: files.length - validFixtures,
      total_size_bytes: totalPayloadBytes
    },
    summary,
    results,
    errors
  };

  const requestedOutput = options.out;
  const outputPath = requestedOutput.toLowerCase().endsWith('.json')
    ? requestedOutput
    : path.join(requestedOutput, `${runId}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\nBenchmark finished.');
  console.log(`Successful fixtures: ${successful.length}/${files.length}`);
  for (const mode of options.modes) {
    const aggregate = summary.modes[mode];
    console.log(`  ${mode}: ${aggregate.aggregate_operations_per_second?.toFixed(2) ?? 'n/a'} ops/sec`);
  }
  console.log(`Report: ${outputPath}`);
  if (errors.length) process.exitCode = 1;
}

try {
  run();
} catch (error) {
  console.error(`[benchmark-json] ${error.message}`);
  process.exitCode = 1;
}

# SAQ Report — JSON Parser Baseline Benchmark

Paket ini menambahkan benchmark mandiri untuk mengukur baseline `JSON.parse()` pada payload yang bentuk dan skenario kondisinya diturunkan dari source code `zuudevs/saq-report`.

> **Dataset:** fixture sintetis deterministik, bukan salinan data MongoDB atau data pengguna. Nama field, root JSON, relasi, fallback, dan cabang kondisi mengikuti implementasi repository yang dirujuk pada `manifest.json`.

## Isi paket

```powershell
$env:SAMPLE/
├── saq-report/                 # 21 fixture JSON, dipindai rekursif

$env:RAW/benchmark/
├── saq-report/
│   ├── manifest.json   # ID, grup, rootKey, dan referensi source tiap fixture
│   └── results/                # Hasil benchmark ditulis di sini

saq-report
├── benchmark/
│   ├── generate-samples.js     # Generator fixture deterministik
│   ├── verify-samples.js       # Validasi fixture dan manifest
│   └── benchmark-json.js       # Benchmark runner
└── README.md
```

## Menjalankan

Persyaratan: Node.js 18 atau lebih baru. Tidak ada dependency npm tambahan.

Jalankan dari root project setelah isi ZIP diekstrak ke root repository `saq-report`:

```bash
# (Opsional) regenerasi 21 fixture dari generator deterministik
node benchmark/generate-samples.js

# Validasi fixture dan mapping manifest
node benchmark/verify-samples.js

# Benchmark default
node benchmark/benchmark-json.js
```

Contoh konfigurasi lebih cepat untuk smoke test:

```bash
node benchmark/benchmark-json.js --samples=3 --warmup=10 --sample-target-ms=2
```

Contoh memilih mode tertentu:

```bash
node benchmark/benchmark-json.js --modes=parse-only,file-read-parse
node benchmark/benchmark-json.js --modes=json-clone
```

Opsi CLI:

| Opsi | Default | Fungsi |
|---|---:|---|
| `--input=DIR` | `data/sample` | Direktori input; dipindai rekursif untuk semua `.json` |
| `--out=DIR` | `benchmark/results` | Direktori hasil atau path file `.json` eksplisit |
| `--samples=N` | `100` | Jumlah batch measurement per mode dan fixture |
| `--warmup=MS` | `100` | Durasi warm-up per mode dan fixture |
| `--sample-target-ms=MS` | `20` | Target durasi setiap batch measurement |
| `--max-operations-per-sample=N` | `1000000` | Batas operasi untuk satu batch |
| `--modes=LIST` | ketiga mode | Pilihan: `parse-only`, `file-read-parse`, `json-clone` |

`--out=benchmark/results/custom-run.json` menulis tepat ke file tersebut. Jika `--out` menunjuk direktori, nama file dibuat otomatis berdasarkan run ID.

## Mode measurement

### 1. `parse-only`

Mengukur `JSON.parse(raw)` pada string UTF-8 yang sudah dibaca ke memori sebelum timer dimulai. Ini adalah baseline parser murni.

### 2. `file-read-parse`

Mengukur `fs.readFileSync(file, 'utf8')`, `JSON.parse(raw)`, dan ekstraksi `rootKey` bila fixture memilikinya. Ini mendekati jalur `JsonRepository.read()` di source app. Pembacaan berulang biasanya memanfaatkan OS page cache; benchmark ini **bukan** pengukuran cold-disk I/O.

### 3. `json-clone`

Mengukur `JSON.parse(JSON.stringify(repositoryValue))` terhadap nilai repository setelah root key diekstrak. Ini merepresentasikan helper `cloneJson()` pada `MongoJsonRepository`, bukan parse file wrapper.

Semua mode dijalankan sequential dengan concurrency 1. Waktu warm-up, kalibrasi batch, pemuatan manifest, pembuatan hash, dan serialisasi laporan tidak dimasukkan ke dalam waktu parse-only.

## Metrik yang dihasilkan

Per fixture dan mode:

- `total_operations`, `total_elapsed_ns`
- latency minimum, maksimum, mean, median/P50, P95, P99, dan population standard deviation
- throughput operations/sec dan MiB/sec
- raw batch samples: operasi, elapsed ns, ns/op, ops/sec, MiB/sec

Metadata run:

- waktu mulai/selesai dan durasi
- commit Git bila paket dijalankan di dalam working tree repository
- versi Node.js/V8, platform, arsitektur, model CPU, logical cores
- konfigurasi benchmark dan metode percentile
- snapshot heap, RSS, external memory, dan ArrayBuffer
- hash SHA-256, ukuran file, tipe root, dan ukuran input clone setiap fixture

Persentil dihitung dengan metode nearest-rank atas `ns_per_operation` per batch. `stddev_ns` adalah population standard deviation dari nilai batch-normalized tersebut; bukan distribusi latency individual setiap operasi.

## Bentuk fixture dan source mapping

Lihat `benchmark/fixture-manifest.json` untuk mapping tiap file. Secara ringkas:

| Grup | Variasi | Source utama |
|---|---|---|
| `persisted` | Asisten, dosen, mata kuliah, jadwal, laporan, konfigurasi global | `routes/*Routes.js`, `repositories/index.js`, `repositories/JsonRepository.js` |
| `service-output` | Enriched schedule/report dan attendance grid | `services/scheduleService.js`, `services/attendanceService.js` |
| `route-input` | Isi JSON mentah untuk `/settings/update-raw` | `routes/settingRoutes.js` |

Root JSON sesuai cara repository menyimpan file:

- `config_asisten.json`: `{ "assistants": [...] }`
- `lecturers.json`: `{ "lecturers": [...] }`
- `courses.json`: `{ "courses": [...] }`
- `schedules.json`: `{ "schedules": [...] }`
- `reports.json`: array root
- `config_global.json`: object root

Nama folder di `data/sample/persisted/` mengelompokkan skenario untuk benchmark; ia bukan klaim bahwa aplikasi menyimpan direktori tersebut. Path JSON aktual di aplikasi berasal dari `config/paths.js`, sedangkan root key/default ditetapkan di `repositories/index.js`.

### Batasan fixture yang disengaja

- Nilai identitas, tanggal, timestamp, dan isi pesan bersifat sintetis serta tetap.
- File gambar tidak disertakan. Fixture hanya menyimpan path/nama file bila cabang route menambahkannya.
- `empty-attendee-edge-case.json` diberi label edge case karena helper `toArray()` dapat menghasilkan array kosong, tetapi itu bukan skenario form normal yang memenuhi validasi minimal.
- `service-output` adalah materialisasi deterministik dari output shape/branch yang dirujuk. Generator berdiri sendiri dan tidak bootstrapping app, mengimpor repository singleton, atau menghubungkan MongoDB.
- Konstanta status `libur` ada di `attendanceService.js`, tetapi builder saat ini tidak mengeluarkan status itu dari cabang yang dipakai fixture; karena itu tidak direkayasa menjadi output grid.
- `express.json()`/HTTP request benchmark tidak digabung ke baseline ini. Untuk mengukur parser murni, `JSON.parse` dipisahkan dari middleware, stream, dan HTTP server.

## Output JSON

Hasil disimpan di `benchmark/results/`. Struktur utama:

```json
{
  "schema_version": "1.0.0",
  "metadata": { "run_id": "...", "runtime": {}, "configuration": {} },
  "dataset": { "files_discovered": 21, "files_valid": 21 },
  "summary": { "modes": {}, "by_group": {} },
  "results": [
    {
      "fixture_id": "persisted.schedules.assistant-ids-single",
      "payload": { "size_bytes": 0, "sha256": "..." },
      "measurements": { "parse-only": {}, "file-read-parse": {}, "json-clone": {} },
      "memory": {}
    }
  ],
  "errors": []
}
```

Nilai aktual menggantikan placeholder pada contoh. Raw samples disertakan pada tiap measurement agar statistik dapat dihitung ulang.

## Membandingkan parser lain

Untuk perbandingan yang adil, parser alternatif harus menerima byte/string yang sama dan mengeluarkan struktur hasil yang setara. Jalankan pada mesin, versi runtime, power mode, dan konfigurasi yang sama. Jangan membandingkan parse-only satu parser dengan file-read-parse parser lain. Gunakan SHA-256 fixture sebagai bukti input identik.

## Sumber repository

- Repository: https://github.com/zuudevs/saq-report
- Referensi file dan perilaku per fixture: `manifest.json`

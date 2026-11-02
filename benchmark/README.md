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
| `--device-label=LABEL` | `hostname` | Penanda device/site untuk run ini; menjadi prefiks `run_id` dan nama file hasil, sehingga hasil dari dua device tidak pernah sampai tumpang tindih |
| `--gc-between` | off | Minta `gc()` antar fixture (butuh Node.js `--expose-gc`; tanpa itu dijalankan dengan peringatan) |

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
- latency minimum, maksimum, mean, **mean_ci95_ns** (interval kepercayaan 95% atas mean, t-distribusi), median/P50, P95, P99, dan population standard deviation
- throughput operations/sec dan MiB/sec
- raw batch samples: operasi, **`started_at_delta_ms`** (waktu relatif awal mode — untuk melihat drift/throttle sepanjang run), elapsed ns, ns/op, ops/sec, MiB/sec

Per fixture (seluruh mode):

- `gc`: jumlah event GC dan total durasi pause selama measurement fixture tersebut
- snapshot memory before/after

Metadata run:

- waktu mulai/selesai dan durasi
- `environment.device_label` (CLI `--device-label`), `hostname`, `os_release`
- `environment.machine_started` / `machine_finished`: model CPU, rentang kecepatan core (MHz), core logis, memori total/bebas, `loadavg`, dan pada Linux: governor cpufreq serta frekuensi aktual saat snapshot (indikasi turbo/throttle). Windows melaporkan `loadavg = [0,0,0]` (lihat `loadavg_note`).
- `environment.node_flags` (`process.execArgv`), `environment.node_options_env` (`NODE_OPTIONS`), dan `runtime_versions` lengkap (`process.versions`) agar dua device harus lulus cek runtime yang sama
- commit Git bila paket dijalankan di dalam working tree repository
- konfigurasi benchmark, metode percentile, stddev, CI, dan `measurement_scope` (mode yang sah jadi kutipan lintas-device)
- snapshot heap, RSS, external memory, dan ArrayBuffer
- `gc` run-level (jumlah event + total pause)
- hash SHA-256, ukuran file, tipe root, dan ukuran input clone setiap fixture

Persentil dihitung dengan metode nearest-rank atas `ns_per_operation` per batch. `stddev_ns` adalah population standard deviation dari nilai batch-normalized tersebut; bukan distribusi latency individual setiap operasi. `mean_ci95_ns` memakai sample variance (n-1) dan kuantil t dua-sisi 0.975 yang dihitung dengan aproksimasi Wilson–Hilferty.

## Bentuk fixture dan source mapping

Lihat `manifest.json` yang berada di `$env:RAW/benchmark/saq-report/manifest.json` (di-generate oleh `generate-samples.js`) untuk mapping tiap file. Secara ringkas:

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
  "schema_version": "1.1.0",
  "metadata": {
    "run_id": "...",
    "runtime": {},
    "environment": { "device_label": "...", "machine_started": {}, "machine_finished": {} },
    "configuration": {}
  },
  "dataset": { "files_discovered": 21, "files_valid": 21 },
  "summary": { "modes": {}, "by_group": {} },
  "results": [
    {
      "fixture_id": "persisted.schedules.assistant-ids-single",
      "payload": { "size_bytes": 0, "sha256": "..." },
      "measurements": { "parse-only": {}, "file-read-parse": {}, "json-clone": {} },
      "gc": { "events": 0, "total_pause_ms": 0 },
      "memory": {}
    }
  ],
  "errors": []
}
```

Nilai aktual menggantikan placeholder pada contoh. Raw samples disertakan pada tiap measurement agar statistik dapat dihitung ulang.

## Membandingkan parser lain

Untuk perbandingan yang adil, parser alternatif harus menerima byte/string yang sama dan mengeluarkan struktur hasil yang setara. Jalankan pada mesin, versi runtime, power mode, dan konfigurasi yang sama. Jangan membandingkan parse-only satu parser dengan file-read-parse parser lain. Gunakan SHA-256 fixture sebagai bukti input identik.

## Protokol perbandingan lintas-device (device sendiri vs server SAQ)

Angka lintas-device hanya valid bila kedua sisi menjalankan paket yang sama dengan prasyarat yang terverifikasi di dalam report:

1. **Fixture identik.** SHA-256 tiap fixture (`payload.sha256`) harus sama di kedua report — generator deterministik menjamin ini, tetapi verifikasi tetap wajib sebelum membandingkan.
2. **Runtime identik.** Node.js `major.minor` sama di kedua device; cek `metadata.environment.runtime_versions` dan `node_flags`/`node_options_env` — flag berbeda dapat mengubah angka tanpa jejak kode.
3. **Device terandal.** Jalankan dengan `--device-label` berbeda (mis. `--device-label=saq-server` di server, `--device-label=<nama-laptop>` di device pengukur) supaya `run_id` dan nama file hasil tidak pernah bertabrakan.
4. **Lingkungan terdokumentasi.** Bandingkan juga `environment.machine_started/finished`: governor, frekuensi aktual, `loadavg`, memori bebas. Server yang sedang sibuk atau sedang thermal-throttle menghasilkan angka menurun yang **bukan** kemampuan parser — angka itu harus dijelaskan dengan metadata, bukan diterima mentah.
5. **Mode yang dikutip.** `parse-only` adalah satu-satunya mode yang layak jadi kutipan utama lintas-device (`measurement_scope.primary_cross_device`). `file-read-parse` bergantung OS page cache/disk (NVMe server vs laptop) dan `json-clone` bergantung karakteristik GC — keduanya ditandai `environment_sensitive`.
6. **Statistik yang dikutip.** Bandingkan P50 (median) dan band-width CI95 (bukan standalone mean); rasio dua device disertai overlap/lebar interval-nya.
7. **Kondisi eksekusi sama.** Sequential, warm-up dan parameter CLI sama di kedua sisi; juga `schema_version` report harus >= `1.1.0` di kedua sisi agar metadata environment tersedia.

Workflow di server SAQ:

```bash
SAMPLE=<dir-sampel> RAW=<dir-artefak> node --expose-gc benchmark/benchmark-json.js \
    --device-label=saq-server --out=$RAW/benchmark/saq-report
```

Hasil server lalu di-join-kan dengan report device pengembang pada kunci `fixture_id + mode + payload.sha256`; selain syarat itu dipenuhi, selisih angka **tidak boleh** dikutip sebagai perbedaan kemampuan.

## Sumber repository

- Repository: https://github.com/zuudevs/saq-report
- Referensi file dan perilaku per fixture: `manifest.json`

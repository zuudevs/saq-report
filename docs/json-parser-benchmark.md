# Benchmark Parser JSON pada SAQ Report

Benchmark utama membandingkan `JSON.parse()` dengan `@zuudevs/ze-json` menggunakan **Benchmark.js**. Pengukuran dijalankan langsung di satu proses Node.js; server HTTP dan middleware Express tidak diperlukan untuk benchmark utama.

## Persyaratan

- Node.js 24 atau lebih baru (binding ze_json menggunakan WebAssembly memory64).
- Dependency terpasang dengan `npm install`.
- Dependency benchmark dipatok di `package.json`: `@zuudevs/ze-json@0.1.6` dan `benchmark@2.1.4`.

## 1. Jalankan benchmark utama

Dari root repository:

    npm run benchmark:json -- --max-time 5 --min-samples 10 --warmup 20

Runner melakukan preflight untuk semua payload, kemudian warm-up eksplisit dan pengukuran adaptif menggunakan Benchmark.js. Jika memakai nilai default, opsi dapat dihilangkan:

    npm run benchmark:json

Opsi:

- `--max-time SEC`: batas waktu Benchmark.js per operasi, default 5 detik.
- `--min-samples N`: jumlah minimum sampel siklus Benchmark.js, default 10.
- `--warmup N`: jumlah pemanggilan warm-up eksplisit per parser dan payload, default 20.
- `--help`: tampilkan bantuan. `--iterations` tidak lagi digunakan di mode ini karena Benchmark.js menentukan jumlah operasi secara adaptif.

Payload deterministik tetap dipertahankan agar dapat dibandingkan dengan hasil HTTP terdahulu:

| Workload | Ukuran |
|---|---:|
| small | 71 byte |
| medium | 5.731 byte |
| large | 73.084 byte |

Ukuran dicek sebelum pengukuran. Perubahan byte yang tidak disengaja menghentikan runner.

## 2. Artefak hasil

Setiap run menyimpan dua file baru di:

    output/benchmarks/json-parser-benchmarkjs/

- `benchmarkjs-<timestamp>-<pid>.json`: metadata runtime dan versi, revisi Git, CPU, hash payload, operasi/s, mean dan median µs/op, RME, jumlah sampel, sampel siklus, serta rasio median per workload.
- `benchmarkjs-<timestamp>-<pid>.md`: tabel ringkas dan batasan metodologi.

Laporan menyimpan versi paket yang benar-benar dimuat oleh runner. Jangan mengambil file JSONL dari mode HTTP lama untuk merangkum hasil Benchmark.js; kedua format dan metode pengukuran berbeda.

## 3. Apa yang diukur?

| Sisi | Operasi terukur |
|---|---|
| `JSON.parse` | `JSON.parse(payloadText)`: parsing penuh dan materialisasi nilai JavaScript |
| `ze_json` | `ze.openDocument(payloadText)`: encodeInto/penulisan UTF-8, reset arena, pemanggilan WASM, scanner, tape, dan persiapan Session On-Demand |

Hasil dari kedua sisi **bukan pekerjaan yang identik**. Rasio hanya menjelaskan latensi operasi yang dicatat, bukan bukti bahwa ze_json lebih cepat untuk semua pola penggunaan atau seluruh pemrosesan end-to-end aplikasi.

Benchmark.js menjalankan operasi dalam proses yang sama dan mengumpulkan sampel waktu per operasi secara adaptif. RME dilaporkan sebagai indikator variasi pengukuran. Urutan parser diseimbangkan antar-workload: JSON-first untuk small/large dan ze-first untuk medium. Ini mengurangi satu pola bias urutan, tetapi tidak menghilangkan seluruh efek urutan, turbo/clock drift, atau gangguan sistem.

`cycle_samples_us_per_op` merupakan sampel siklus Benchmark.js, bukan jumlah request HTTP atau jumlah pemanggilan parser individual yang tetap.

## 4. Mode HTTP lama

Mode lama tetap disediakan untuk menilai middleware Express atau mereproduksi hasil JSONL sebelumnya, tetapi **bukan benchmark utama**.

Terminal pertama:

    npm run start:benchmark

Terminal kedua:

    npm run benchmark:json:http -- --iterations 100 --warmup 20

Ringkas hasil JSONL mode HTTP dengan:

    $run = Get-ChildItem .\output\benchmarks\json-parser\*.jsonl -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    npm run summarize:json-benchmark:http -- "$($run.FullName)"

Mode HTTP memasukkan overhead server ke konteks request, walaupun timer parser yang dicatat di middleware sendiri terpisah dari durasi jaringan. Jangan mencampur artefak mode HTTP dan Benchmark.js dalam satu analisis tanpa label metode.

## 5. Server HTTP live: Benchmark.js per request (sampel mentah)

Untuk pengumpulan data lewat HTTP, tersedia server yang menjalankan **satu Benchmark.Suite per request** atas payload yang dikirim, lalu menyimpan **array sampel mentah** `stats.sample` Benchmark.js ke file data — tanpa kalkulasi perbandingan dan tanpa penentuan pemenang di sisi server. Analisis statistik (mis. Wilcoxon signed-rank atas pasangan sampel per request) dikerjakan terpisah atas file data ini.

Jalankan server:

    npm run start:raw-benchmark -- --port 3100 --max-time 5 --min-samples 10

Kirim payload (raw JSON pada body, `Content-Type: application/json`):

    curl -X POST http://127.0.0.1:3100/benchmark ^
      -H "Content-Type: application/json" ^
      -H "x-benchmark-workload: medium" ^
      --data-binary @payload.json

Respons klien hanya `200 {"status":"saved"}`; tidak ada data benchmark yang dikirim balik. Header opsional `x-benchmark-phase` (`warmup`/`measurement`) dan `x-benchmark-workload` (label bebas, dipotong 80 karakter) dicatat ke record. Client `npm run benchmark:json:http` juga kompatibel — turunkan `--iterations`/`--warmup` karena setiap request kini menjalankan satu suite penuh (dengan `--max-time 5`, satu request biasanya 5–20 detik).

### Alur per request

1. Validasi di luar jalur terukur: body `application/json`, tidak kosong, BOM dibuang, ukuran UTF-8 `< 1 MiB` (region payload binding ze_json), `JSON.parse` valid, root harus object (kontrak Session ze_json), dan preflight satu `ze.openDocument` agar payload yang ditolak scanner digagalkan cepat.
2. Dibuat `Benchmark.Suite` dengan dua test: `JSON.parse(payload)` dan `ze_json` → `ze.openDocument(payload)` (metodologi sama dengan mode offline). Urutan penambahan bergantian per request dan dicatat di `execution_order`.
3. Suite dijalankan asinkron; event `cycle` mengekstrak `event.target.stats.sample` per test, event `complete` merakit record.
4. Record ditambahkan ke file data, lalu klien menerima `{"status":"saved"}`.

### Keamanan race condition

- **Antrian eksekusi:** hanya satu suite boleh berjalan pada satu waktu. Request berdekatan diantrekan FIFO (default maksimum 64; lebihnya ditolak `503`) sehingga siklus pengukuran tidak saling mengganggu dan payload satu request tidak pernah tercampur dengan request lain.
- **Antrian penulisan:** setiap `fs.promises.appendFile` menunggu tulisan sebelumnya tuntas (janji berantai), sehingga baris data tidak pernah tercampur meski banyak request diterima hampir bersamaan. Respons `saved` hanya dikirim setelah tulisan selesai.
- **Format JSON Lines:** file data bernama `raw_benchmark_data.json` tetapi berformat NDJSON (satu objek JSON per baris) — append aman, mudah dibaca per baris, dan crash paling banyak membuang baris terakhir. Baca dengan `JSON.parse` per baris atau `pandas.read_json(..., lines=True)`.

File data default: `output/benchmarks/json-parser/raw_benchmark_data.json` (ubah dengan `--data-file` atau `RAW_BENCHMARK_DATA_FILE`).

### Skema record (satu baris)

| Bidang | Isi |
|---|---|
| `sequence`, `timestamp` | Nomor urut request seumur server dan waktu ISO |
| `benchmark_phase`, `workload` | Label dari header request (untuk analisis) |
| `execution_order` | `json_parse-first` / `ze_json-first` (bergantian) |
| `payload_bytes`, `payload_chars`, `payload_sha256` | Ukuran dan identitas payload terukur |
| `configuration`, `runtime`, `libraries` | `max_time_seconds`, `min_samples`, `warmup_calls_per_parser`, `scanner_variant`; versi Node/CPU; versi ze_json & Benchmark.js |
| `results[]` | Per test: `name` (`JSON.parse`/`ze_json`), `status`, `error_message`, `aborted`, `count`, `cycles`, `sample_unit`, `sample` |

Catatan pembacaan `results[]`:

- `sample` = array mentah `stats.sample` Benchmark.js, satuan `seconds_per_op` (detik per operasi, satu entri per siklus terukur, tanpa penyaringan).
- `cycles` = jumlah siklus **kalibrasi/ramp-up** Benchmark.js (bukan panjang `sample`); `count` = jumlah operasi per siklus terukur; panjang `sample` = jumlah siklus terukur.
- Server sengaja tidak menyimpan mean/median/hz maupun rasio antar parser; semua statistik dihitung dari `sample` saat analisis.

### Menggunakan payload nyata dari aplikasi (feeder)

Untuk mengisi server benchmark dengan **laporan SAQ asli** (bukan payload sintetis), jalankan feeder. Server benchmark tetap berjalan sebagai proses terisolasi; feeder hanya membaca data lalu mengirimkannya.

Terminal pertama (server benchmark):

    npm run start:raw-benchmark

Terminal kedua (feeder; menarik laporan lewat jalur repository yang sama dengan aplikasi — membutuhkan MongoDB aktif dan `.env` terkonfigurasi):

    npm run benchmark:json:real -- --limit 20 --repeats 5 --batch-size 10

Opsi feeder:

- `--limit N`: jumlah laporan tunggal yang dikirim; tiap laporan dikirim apa adanya (workload `saq-report`).
- `--batch-size N`: kirim juga envelope `{"reports": [N laporan]}` per potongan data (workload `saq-report-batch-N`) untuk kelas ukuran besar dari data nyata; `--batch-limit` membatasi jumlah potongan.
- `--repeats N`: tiap payload dikirim N kali dengan urutan teracak deterministik — ulangan menghasilkan pasangan (identitas payload sama via `payload_sha256`) yang siap diuji Wilcoxon per workload.
- `--from-file PATH`: baca array laporan dari file JSON alih-alih dari MongoDB (format `[...]` atau `{"reports": [...]}`) — berguna saat MongoDB tidak berjalan atau untuk dataset tetap yang dapat direproduksi.
- `--phase warmup|measurement`: label fase pada record.

Catatan durasi: satu POST = satu suite Benchmark.js, jadi hitung total waktu ≈ (jumlah payload × ulangan) × durasi per request server (±13 detik pada default, ±2 detik pada `--max-time 0.5`).

### Batasan

- Root payload wajib JSON object; ukuran < 1 MiB; Node.js >= 24.
- ze_json dipatok `0.1.6`; arsitektur scanner berubah dibanding versi sebelumnya (goto-automaton di-revert ke stack-bit + SWAR), sehingga hasil 0.1.3 atau lebih lama **tidak sebanding** — jangan campur data lintas versi dalam satu analisis.
- Varian scanner dapat dipilih lewat `--scanner auto|scalar|wide` (default `auto`); pilihan tercatat di `configuration.scanner_variant` tiap record.
- `server.requestTimeout` dimatikan karena satu request dapat berlangsung puluhan detik saat antrian penuh; gunakan HTTP client dengan timeout panjang.
- File data JSON Lines tidak dicampur dengan hasil mode lain; beri label metode saat analisis.


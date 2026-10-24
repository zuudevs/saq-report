# Benchmark Parser JSON pada SAQ Report

Benchmark utama membandingkan `JSON.parse()` dengan `@zuudevs/ze-json` menggunakan **Benchmark.js**. Pengukuran dijalankan langsung di satu proses Node.js; server HTTP dan middleware Express tidak diperlukan untuk benchmark utama.

## Persyaratan

- Node.js 24 atau lebih baru (binding ze_json menggunakan WebAssembly memory64).
- Dependency terpasang dengan `npm install`.
- Dependency benchmark dipatok di `package.json`: `@zuudevs/ze-json@0.1.3` dan `benchmark@2.1.4`.

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

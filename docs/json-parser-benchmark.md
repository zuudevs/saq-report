# Benchmark Parser JSON pada SAQ Report

Eksperimen ini membandingkan pemrosesan raw body `application/json` yang sama melalui `@zuudevs/ze-json` dan `JSON.parse()`. Dalam mode aplikasi, hasil `JSON.parse()` tetap digunakan sebagai `req.body`; `ze_json` diukur sebagai parser pembanding. Mode mandiri mengisolasi tahap parser tanpa database, scheduler, atau klien WhatsApp.

## Persyaratan

- Node.js 24 atau lebih baru (binding ze_json memakai WebAssembly memory64).
- Dependensi npm sudah diinstal melalui `npm install`.

Paket npm `@zuudevs/ze-json` menyertakan binding JavaScript dan file WASM yang sudah dibangun. Mode benchmark mandiri tidak membutuhkan checkout submodule, CMake, Ninja, LLVM/Clang, MongoDB, atau Docker.

## Prosedur benchmark yang direkomendasikan

### 1. Jalankan server benchmark mandiri

Dari folder root repository:

    npm run start:benchmark

Server berjalan di `http://127.0.0.1:3100` (dapat diubah dengan `BENCHMARK_HOST` dan `BENCHMARK_PORT`). Health check:

    Invoke-RestMethod -Uri http://127.0.0.1:3100/health

### 2. Jalankan runner dengan warm-up dan payload terkontrol

Buka terminal kedua di folder repository:

    npm run benchmark:json -- --iterations 100 --warmup 20

Runner mengirim tiga payload object deterministik (small, medium, large). Secara default, setiap payload mendapat 20 request warm-up dan 100 sampel terukur. Urutan workload terukur diacak secara deterministik agar ukuran payload tidak selalu diuji dalam urutan yang sama. Nilai warm-up diberi header `X-Benchmark-Phase: warmup`, dan diberi label workload melalui header `X-Benchmark-Workload`.

Opsi yang tersedia:

- `--iterations N`: jumlah sampel terukur per payload, default 100.
- `--warmup N`: jumlah request warm-up per payload, default 20.
- `--url URL`: URL endpoint benchmark, default `http://127.0.0.1:3100/benchmark`.
- `--help`: tampilkan bantuan.

Contoh untuk pengujian lebih singkat:

    npm run benchmark:json -- --iterations 30 --warmup 10

Runner bersifat serial; waktu jaringan tidak dimasukkan ke durasi parser yang diukur di server, tetapi aktivitas sistem tetap dapat memengaruhi hasil. Untuk hasil yang lebih kuat, jalankan beberapa proses/batch independen pada kondisi mesin yang sebanding.

### 3. Buat ringkasan dari JSONL terbaru

Setelah runner selesai:

    $run = Get-ChildItem .\output\benchmarks\json-parser\*.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    npm run summarize:json-benchmark -- "$($run.FullName)"

Skrip membuat file `.summary.json` di sebelah JSONL. Ringkasan melaporkan statistik agregat dan per payload hash/workload, jumlah warm-up yang dikecualikan, rasio median per request, rasio dari median waktu, geometric mean rasio, throughput perkiraan, dan dugaan outlier.

## Cara membaca hasil

- `median_per_request_speedup_ratio` adalah median rasio waktu `JSON.parse()` dibagi waktu `ze_json` untuk setiap request. Nilai lebih besar dari 1 berarti `ze_json` lebih cepat menurut rasio itu.
- `speedup_ratio_from_medians` membagi median waktu `JSON.parse()` dengan median waktu `ze_json`. Nilai ini tidak selalu sama dengan median rasio per request.
- Untuk jumlah sampel genap, median adalah rata-rata dua nilai tengah. P95 menggunakan nearest-rank.
- Urutan pemanggilan parser digilir antara `ze_json-first` dan `json_parse-first`, serta dicatat pada tiap baris JSONL untuk membantu memeriksa bias urutan.
- Dugaan outlier ditandai menggunakan Tukey upper fence (`Q3 + 1.5 × IQR`) per kelompok payload dan parser. Outlier **tidak dihapus** dari statistik utama.
- Throughput agregat dihitung dari jumlah byte dibagi jumlah durasi parser. Ia dapat sangat terpengaruh oleh outlier; baca bersama median, P95, rata-rata, dan maksimum.
- JSONL menyimpan metadata payload termasuk SHA-256, ukuran, rute, phase, workload, urutan eksekusi, status parser, dan durasi. Payload mentah tidak disimpan.

## Mode aplikasi penuh

Jika perlu mengukur request yang masuk ke middleware aplikasi SAQ Report sesungguhnya, jalankan:

    npm run start:benchmark:app

Mode ini membutuhkan MongoDB dan layanan yang diperlukan aplikasi. Untuk membandingkan tahap parser tanpa gangguan dari browser WhatsApp, scheduler, database, atau route bisnis, prioritaskan mode mandiri.

## Batasan metodologi

- Durasi `ze_json` mengukur scan/validasi, pembangunan tape struktural, dan inisialisasi Session on-demand melalui binding WASM. Hasil Doc tidak ditelusuri lebih lanjut.
- Durasi `JSON.parse()` mengukur parsing penuh dan materialisasi nilai JavaScript. Workload kedua parser tidak identik, jadi rasio bukan bukti bahwa pemrosesan end-to-end aplikasi menjadi secepat itu.
- Binding `ze_json` yang diuji ditujukan untuk root object dengan payload di bawah 1 MiB. Hanya payload yang didukung dan berhasil oleh kedua parser masuk rasio perbandingan.
- Semua hasil, termasuk sampel ekstrem, dipertahankan. Outlier perlu ditinjau dan diuji ulang, bukan dihapus hanya karena membuat hasil kurang menguntungkan.


Diagnostik: baris JSONL menyimpan nama dan pesan error parser. Statistik dan rasio komparatif hanya memakai sampel ketika kedua parser sukses; latensi percobaan yang gagal masih ditampilkan terpisah.

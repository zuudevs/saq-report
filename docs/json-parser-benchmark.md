# Benchmark Parser JSON pada SAQ Report

Fitur ini menyediakan mode eksperimen yang menerima raw body bertipe application/json, mencoba memproses payload yang sama dengan ze_json, lalu memprosesnya dengan JSON.parse. Nilai hasil JSON.parse tetap dipakai oleh route SAQ Report; hasil dari ze_json hanya dipakai untuk pengukuran.

## Persyaratan dan instalasi

- Node.js 24 atau lebih baru (binding ze_json memakai WebAssembly memory64).
- Dependensi npm diinstal dari package-lock.json.

Paket npm \`@zuudevs/ze-json\` menyertakan binding JavaScript dan file WASM yang sudah dibangun, sehingga tidak perlu checkout submodule, CMake, Ninja, atau LLVM/Clang pada mesin yang menjalankan aplikasi.

Setelah checkout branch:

    npm install

## Menjalankan benchmark

Jalankan perintah berikut saat ingin mengukur request JSON yang masuk. Mode ini menjalankan server SAQ Report normal; karena aplikasi menginisialisasi MongoDB dan klien WhatsApp, konfigurasi layanan yang biasa tetap diperlukan.

    npm run start:benchmark

Secara default, hasil ditulis ke \`output/benchmarks/json-parser\`. Setiap request application/json menghasilkan satu baris JSONL yang berisi timestamp, method, path tanpa query string, ukuran body, SHA-256 payload, status kedua parser, durasi dalam nanodetik, dan rasio waktu bila payload dapat dibandingkan. Payload mentah tidak disimpan.

Lokasi output dapat diubah menggunakan \`JSON_PARSER_BENCHMARK_DIR\`. Batas body JSON tetap 100 KiB secara default, seperti middleware Express sebelumnya; dapat diubah memakai \`JSON_BODY_LIMIT\`.

Untuk menghasilkan ringkasan satu file hasil:

    npm run summarize:json-benchmark -- output/benchmarks/json-parser/json-parser-<run-id>-<pid>.jsonl

Skrip membuat file \`.summary.json\` di sebelah JSONL, berisi min, median, mean, p95, max, jumlah payload yang bisa dibandingkan, kegagalan parser, rasio median, dan throughput perkiraan. Metrik throughput tidak memasukkan biaya tulis berkas hasil.

## Arti hasil dan batasan interpretasi

- Durasi ze_json mengukur scanner/validasi, pembuatan tape struktural, dan inisialisasi Session on-demand melalui binding WASM.
- Durasi JSON.parse mengukur parsing penuh dan materialisasi nilai JavaScript. Karena JSON.parse menghasilkan object lengkap sedangkan ze_json on-demand tidak, keduanya bukan workload yang setara; rasio adalah perbandingan tahap parser yang sengaja dipakai aplikasi ini, bukan klaim kecepatan end-to-end yang setara.
- API JavaScript ze_json saat ini ditujukan untuk Session ber-root object dan memiliki region payload 1 MiB. Payload root bukan object atau payload berukuran sama dengan/di atas batas region tetap diproses oleh JSON.parse untuk menjaga perilaku aplikasi, tetapi tidak dimasukkan ke rasio perbandingan.
- Jika ze_json gagal memproses payload, request tetap mengikuti hasil JSON.parse. Kegagalan ze_json dicatat pada hasil benchmark, tidak menggagalkan request valid.
- Payload hanya diidentifikasi dengan SHA-256; isi body tidak dicatat. Hasil benchmark lokal dapat berisi path endpoint dan waktu request, sehingga jangan dipublikasikan tanpa meninjau kebutuhan privasi.
- Mode benchmark tidak aktif pada npm start atau npm run dev. Gunakan npm run start:benchmark hanya saat eksperimen; output ditulis asinkron di luar interval yang diukur, tetapi tetap ada overhead pencatatan pada server.

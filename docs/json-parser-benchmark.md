# Benchmark Parser JSON pada SAQ Report

Eksperimen ini membandingkan pemrosesan raw body \`application/json\` yang sama melalui \`@zuudevs/ze-json\` dan \`JSON.parse()\`. Hasil \`JSON.parse()\` digunakan sebagai \`req.body\` pada mode terintegrasi; untuk mode mandiri, hasilnya dikembalikan sebagai ringkasan respons HTTP.

## Persyaratan

- Node.js 24 atau lebih baru (binding ze_json memakai WebAssembly memory64).
- Dependensi npm sudah diinstal melalui \`npm install\`.

Paket npm \`@zuudevs/ze-json\` menyertakan binding JavaScript dan file WASM yang sudah dibangun. Tidak perlu checkout submodule, CMake, Ninja, LLVM/Clang, MongoDB, atau Docker untuk menjalankan **mode benchmark mandiri**.

## Mode A — benchmark mandiri tanpa MongoDB/Docker

Dari folder root repository:

    npm run start:benchmark

Server benchmark berjalan di \`http://127.0.0.1:3100\` (dapat diubah dengan \`BENCHMARK_HOST\` dan \`BENCHMARK_PORT\`). Mode ini hanya menjalankan penerima benchmark ringan dan tidak memuat route bisnis, MongoDB, scheduler, ataupun klien WhatsApp SAQ Report. Ini berguna untuk mengukur overhead tahap parser secara terisolasi.

Health check:

    Invoke-RestMethod -Uri http://127.0.0.1:3100/health

Kirim payload JSON contoh dari PowerShell:

    $payload = '{"source":"manual-test","ok":true,"numbers":[1,2,3]}'
    Invoke-RestMethod -Uri http://127.0.0.1:3100/benchmark -Method Post -ContentType 'application/json' -Body $payload

Setiap request \`application/json\` dicoba dengan ze_json lalu JSON.parse. Endpoint \`POST /benchmark\` akan mengembalikan status sederhana dan daftar key object. Payload mentah tidak disimpan.

## Mode B — aplikasi SAQ Report lengkap

Jika kamu perlu melewatkan request melalui route SAQ Report sesungguhnya, jalankan:

    npm run start:benchmark:app

Mode ini memuat seluruh aplikasi dan **tetap membutuhkan MongoDB serta layanan lain yang diperlukan aplikasi**. Gunakan mode ini jika ingin mengukur parser di alur request yang sungguh-sungguh melewati aplikasi, bukan eksperimen parser terisolasi.

## Hasil dan ringkasan

Secara default, hasil ditulis ke \`output/benchmarks/json-parser\`. Setiap baris JSONL berisi timestamp, method, path tanpa query string, ukuran body, SHA-256 payload, status kedua parser, durasi dalam nanodetik, dan rasio waktu bila payload dapat dibandingkan. Lokasi output dapat diubah memakai \`JSON_PARSER_BENCHMARK_DIR\`. Batas body JSON default adalah 100 KiB dan dapat diubah lewat \`JSON_BODY_LIMIT\`.

Untuk membuat ringkasan file hasil:

    $run = Get-ChildItem .\output\benchmarks\json-parser\*.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    npm run summarize:json-benchmark -- $run.FullName

Skrip membuat file \`.summary.json\` di sebelah JSONL, berisi minimum, median, rata-rata, p95, maksimum, jumlah payload yang bisa dibandingkan, kegagalan parser, rasio median, dan throughput perkiraan.

## Interpretasi dan batasan

- Durasi ze_json mengukur scanner/validasi, pembuatan tape struktural, dan inisialisasi Session on-demand melalui binding WASM.
- Durasi JSON.parse mengukur parsing penuh dan materialisasi nilai JavaScript. Karena JSON.parse menghasilkan object lengkap sedangkan ze_json on-demand tidak, keduanya bukan workload yang setara. Rasio bukan bukti bahwa pemrosesan end-to-end aplikasi menjadi secepat itu.
- API JavaScript ze_json ditujukan untuk Session ber-root object dan memiliki region payload 1 MiB. Hanya root object dengan ukuran di bawah 1 MiB yang masuk ke rasio; payload lain tetap dicoba oleh JSON.parse tetapi tidak dinyatakan sebanding.
- Jika ze_json gagal, request yang valid tetap diproses oleh JSON.parse dan kegagalan dicatat di hasil.
- Isi payload tidak dicatat, hanya SHA-256. Path endpoint dan timestamp tetap tercatat, jadi periksa output sebelum membagikannya.
- Gunakan \`npm run start:benchmark\` untuk kebutuhan tanpa database. Gunakan \`npm run start:benchmark:app\` hanya saat dependensi aplikasi lengkap tersedia.

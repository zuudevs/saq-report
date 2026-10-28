# Benchmark Parser JSON pada SAQ Report

Benchmark membandingkan `JSON.parse()` dengan `@zuudevs/ze-json` (binding wasm64 `ze.openDocument`) menggunakan **Benchmark.js**. Seluruh pengukuran berjalan **terisolasi dari aplikasi utama** — server benchmark dan runner offline adalah proses terpisah; Express, MongoDB, dan client WhatsApp tidak berada di jalur terukur.

Dua jalur pengukuran:

| Jalur | Perintah | Payload | Peran |
|---|---|---|---|
| **Utama — live server + feeder** | `start:raw-benchmark` + `benchmark:json:real` | Laporan SAQ nyata dari MongoDB | Sumber data statistik skripsi |
| Pelengkap — runner offline | `benchmark:json` | Sintetis deterministik (71 B / 5.731 B / 73.084 B) | Pembanding antar-ukuran yang terkontrol |

## Persyaratan

- Node.js 24 atau lebih baru (binding ze_json menggunakan WebAssembly memory64).
- Dependency terpasang dengan `npm install`.
- Versi dipatok di `package.json`: `@zuudevs/ze-json@0.1.6` dan `benchmark@2.1.4`.
- Feeder jalur utama membutuhkan MongoDB aktif dan `.env` terkonfigurasi (sama seperti aplikasi normal); gunakan `--from-file` bila MongoDB tidak berjalan.

## 1. Jalur utama — server raw benchmark + feeder payload nyata

Server benchmark menerima payload lewat HTTP, menjalankan satu `Benchmark.Suite` (`JSON.parse(payload)` vs `ze_json(payload)`) per request, lalu menyimpan **array sampel mentah** `stats.sample` ke file data — **tanpa kalkulasi perbandingan dan tanpa penentuan pemenang di sisi server**. Analisis statistik dikerjakan offline dari file data.

Terminal pertama (server):

    npm run start:raw-benchmark

Terminal kedua (feeder — menarik laporan SAQ nyata lewat jalur repository yang sama dengan aplikasi):

    npm run benchmark:json:real -- --limit 30 --repeats 10 --batch-size 10

Pengiriman manual (payload apa pun: root JSON object, ukuran UTF-8 < 1 MiB):

    curl.exe -X POST http://127.0.0.1:3100/benchmark ^
      -H "Content-Type: application/json" ^
      -H "x-benchmark-workload: medium" ^
      --data-binary @payload.json

Respons klien hanya `200 {"status":"saved"}` — data benchmark tidak dikirim balik ke klien. Header opsional `x-benchmark-phase` (`warmup`/`measurement`) dan `x-benchmark-workload` (label bebas, dipotong 80 karakter) tercatat pada record.

### Alur per request

1. Validasi di luar jalur terukur: body `application/json`, tidak kosong, BOM dibuang, ukuran UTF-8 < 1 MiB (region payload binding ze_json), `JSON.parse` valid, root harus object (kontrak Session ze_json), dan preflight satu `ze.openDocument` agar payload yang ditolak scanner digagalkan cepat.
2. Dibuat `Benchmark.Suite` dengan dua test: `JSON.parse(payload)` dan `ze_json` → `ze.openDocument(payload)` (encodeInto + reset arena + scanner/tape + persiapan Session). Urutan penambahan bergantian per request dan dicatat di `execution_order`.
3. Suite dijalankan asinkron; event `cycle` mengekstrak `event.target.stats.sample` per test, event `complete` merakit record.
4. Record ditambahkan ke file data, lalu klien menerima `{"status":"saved"}`.

### Keamanan race condition

- **Antrian eksekusi:** hanya satu suite boleh berjalan pada satu waktu. Request berdekatan diantrekan FIFO (default maksimum 64; lebihnya ditolak `503`) sehingga siklus pengukuran tidak saling mengganggu dan payload satu request tidak pernah tercampur dengan request lain.
- **Antrian penulisan:** setiap `fs.promises.appendFile` menunggu tulisan sebelumnya tuntas (janji berantai), sehingga baris data tidak pernah tercampur meski banyak request diterima hampir bersamaan. Respons `saved` hanya dikirim setelah tulisan selesai.
- **Format JSON Lines:** file data bernama `raw_benchmark_data.json` tetapi berformat NDJSON (satu objek JSON per baris) — append aman, mudah dibaca per baris, dan crash paling banyak membuang baris terakhir. Baca dengan `JSON.parse` per baris atau `pandas.read_json(..., lines=True)`.

File data default: `output/benchmarks/json-parser/raw_benchmark_data.json` (ubah dengan `--data-file` atau `RAW_BENCHMARK_DATA_FILE`).

### Opsi server (`start:raw-benchmark`)

| Opsi | Default | Keterangan |
|---|---|---|
| `--port N` / `--host H` | `BENCHMARK_PORT`/`BENCHMARK_HOST`, 3100/127.0.0.1 | Alamat bind |
| `--max-time SEC` | 5 | Batas waktu Benchmark.js per test |
| `--min-samples N` | 10 | Sampel siklus minimum per test |
| `--warmup N` | 20 | Panggilan warm-up eksplisit per parser sebelum suite |
| `--max-queue N` | 64 | Batas job menunggu; selebihnya ditolak 503 |
| `--data-file PATH` | `RAW_BENCHMARK_DATA_FILE` atau default | File data JSON Lines |
| `--body-limit B` | `JSON_BODY_LIMIT` atau `1mb` | Batas body body-parser |
| `--scanner V` | `auto` | Varian scanner ze_json: `auto` \| `scalar` \| `wide` |
| `--help` | | Tampilkan bantuan |

Satu request ≈ 13 detik pada default (`--max-time 5`); turunkan `--max-time` untuk iterasi cepat.

### Opsi feeder (`benchmark:json:real`)

| Opsi | Default | Keterangan |
|---|---|---|
| `--url URL` | `JSON_BENCHMARK_URL` atau `http://127.0.0.1:3100/benchmark` | Endpoint benchmark |
| `--limit N` | 20 | Maksimum laporan tunggal yang dikirim (workload `saq-report`) |
| `--batch-size N` | 0 | Kirim juga envelope `{"reports": [N laporan]}` (workload `saq-report-batch-N`) untuk kelas ukuran besar dari data nyata |
| `--batch-limit N` | 5 | Maksimum potongan envelope |
| `--repeats N` | 1 | Tiap payload dikirim N kali, urutan teracak deterministik — ulangan = pasangan per `payload_sha256` untuk uji statistik |
| `--phase P` | `measurement` | Label fase pada record |
| `--from-file PATH` | — | Baca array laporan dari file JSON alih-alih MongoDB |
| `--help` | | Tampilkan bantuan |

Payload ≥ 1 MiB otomatis dilewati dengan peringatan.

### Skema record (satu baris JSON Lines)

| Bidang | Isi |
|---|---|
| `sequence`, `timestamp` | Nomor urut request seumur server dan waktu ISO |
| `benchmark_phase`, `workload` | Label dari header request |
| `execution_order` | `json_parse-first` / `ze_json-first` (bergantian) |
| `payload_bytes`, `payload_chars`, `payload_sha256` | Ukuran dan identitas payload terukur |
| `configuration`, `runtime`, `libraries` | `max_time_seconds`, `min_samples`, `warmup_calls_per_parser`, `scanner_variant`; versi Node/CPU; versi ze_json & Benchmark.js |
| `results[]` | Per test: `name` (`JSON.parse`/`ze_json`), `status`, `error_message`, `aborted`, `count`, `cycles`, `sample_unit`, `sample` |

Catatan pembacaan `results[]`:

- `sample` = array mentah `stats.sample` Benchmark.js, satuan `seconds_per_op` (detik per operasi, satu entri per siklus terukur, tanpa penyaringan).
- `cycles` = jumlah siklus **kalibrasi/ramp-up** Benchmark.js (bukan panjang `sample`); `count` = jumlah operasi per siklus terukur; panjang `sample` = jumlah siklus terukur.
- Server sengaja tidak menyimpan mean/median/hz maupun rasio antar parser; semua statistik dihitung dari `sample` saat analisis.

### Batasan

- Root payload wajib JSON object; ukuran < 1 MiB; Node.js >= 24.
- ze_json dipatok `0.1.6`; arsitektur scanner berubah dibanding versi sebelumnya (goto-automaton di-revert ke stack-bit + SWAR), sehingga hasil 0.1.3 atau lebih lama **tidak sebanding** — jangan campur data lintas versi dalam satu analisis.
- Varian scanner dapat dipilih lewat `--scanner auto|scalar|wide` (default `auto`); pilihan tercatat di `configuration.scanner_variant` tiap record.
- `server.requestTimeout` dimatikan karena satu request dapat berlangsung puluhan detik saat antrian penuh; gunakan HTTP client dengan timeout panjang.
- File data JSON Lines tidak dicampur dengan hasil mode lain; beri label metode saat analisis.

## 2. Pelengkap — runner offline payload sintetis

    npm run benchmark:json -- --max-time 5 --min-samples 10 --warmup 20

Runner murni Benchmark.js tanpa HTTP: preflight + warm-up eksplisit + pengukuran adaptif atas tiga payload deterministik (small 71 B, medium 5.731 B, large 73.084 B — byte dicek sebelum pengukuran). Artefak per run tersimpan di `output/benchmarks/json-parser-benchmarkjs/`:

- `benchmarkjs-<timestamp>-<pid>.json` — metadata runtime, versi, revisi Git, CPU, operasi/s, mean/median µs/op, RME, jumlah sampel, sampel siklus, rasio median per workload.
- `benchmarkjs-<timestamp>-<pid>.md` — tabel ringkas dan batasan metodologi.

Opsi: `--max-time SEC` (default 5), `--min-samples N` (default 10), `--warmup N` (default 20), `--help`. `--iterations` tidak berlaku — Benchmark.js menentukan jumlah operasi secara adaptif.

## 3. Apa yang diukur

| Sisi | Operasi terukur |
|---|---|
| `JSON.parse` | `JSON.parse(payloadText)`: parsing penuh dan materialisasi nilai JavaScript |
| `ze_json` | `ze.openDocument(payloadText)`: encodeInto/penulisan UTF-8, reset arena, pemanggilan WASM, scanner, tape, dan persiapan Session on-demand |

Hasil kedua sisi **bukan pekerjaan yang identik**. Rasio hanya menjelaskan latensi operasi yang dicatat, bukan bukti bahwa kedua parser menyelesaikan pekerjaan setara untuk semua pola penggunaan. Urutan parser diseimbangkan (bergantian) untuk mengurangi bias urutan, tetapi efek turbo/clock drift dan gangguan sistem tidak sepenuhnya hilang.

## 4. Analisis offline dari file data

```python
import json, pandas as pd
from scipy.stats import wilcoxon

rows = [json.loads(l) for l in open('raw_benchmark_data.json', encoding='utf-8') if l.strip()]
data = []
for r in rows:
    e = {'workload': r['workload'], 'sha': r['payload_sha256'], 'seq': r['sequence']}
    for res in r['results']:
        e[res['name']] = res['sample']          # detik/op
    data.append(e)
df = pd.DataFrame(data)

per_req = df.assign(
    j=lambda d: d['JSON.parse'].apply(lambda s: pd.Series(s).median()),
    z=lambda d: d['ze_json'].apply(lambda s: pd.Series(s).median()),
)
for (workload, sha), g in per_req.groupby(['workload', 'sha']):
    if len(g) < 5:
        continue  # payload tanpa ulangan tidak diuji
    stat, p = wilcoxon(g['j'], g['z'])
    print(f'{workload:22} n_request={len(g):3}  '
          f'median JSON={g["j"].median()*1e6:9.2f} us/op  '
          f'ze={g["z"].median()*1e6:9.2f} us/op  p={p:.2e}')
```

Pasangkan per-request (kedua test pada payload sama) lalu uji Wilcoxon signed-rank lintas ulangan per identitas payload (`payload_sha256`).

## Catatan riwayat

Mode benchmark terintegrasi ke aplikasi (middleware pengukur per-request berbasis `hrtime`, skrip `start:benchmark`/`start:benchmark:app` beserta client dan summarizer JSONL-nya) telah dihapus karena cakupan trafik JSON aplikasi terbukti sangat sempit — laporan SAQ masuk sebagai teks WhatsApp, bukan JSON HTTP. File JSONL lama di `output/benchmarks/json-parser/` tetap dipertahankan sebagai data historis (di-ignore git); skripnya dapat dipulihkan dari riwayat Git bila diperlukan.

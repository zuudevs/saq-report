# AGENTS.md

SAQ Report — Express + WhatsApp Web bot for ITPLN practicum assistant (asisten) reporting: assistants send captioned images to a WhatsApp group, the bot parses them into reports stored in MongoDB, and the web UI exports DOCX/XLSX documents. Skripsi project. **Comments, logs, and UI are in Bahasa Indonesia — keep new code consistent.**

## Commands

- `npm start` / `npm run dev` — needs MongoDB running + `.env` (copy `.env.example`). Boots Express AND the WhatsApp client; QR for pairing renders at `/whatsapp/qr`.
- `npm run export` — CLI exporter, not a build step: `--rekap`, `--berita-acara`, `--docx`, `--month=4`, `--year=2026` (see `scripts/export.js`). Outputs land in `Export/<academic-year>/` (gitignored).
- **`npm test` is a stub that exits 1. There is no test suite, linter, formatter, or CI.** Verify changes by running the app or the exporter.
- JSON parser benchmarks (thesis experiment, isolated from the app): `npm run start:raw-benchmark` (server, port 3100) + `npm run benchmark:json:real -- --limit 30 --repeats 10` (feeder, needs MongoDB or `--from-file`); `npm run benchmark:json` for the offline synthetic runner. **Requires Node.js ≥ 24** (ze_json wasm64). Full reference: `docs/json-parser-benchmark.md`.

## Critical gotchas

- **`postinstall` patches node_modules**: `scripts/patch-wwebjs.js` rewrites `whatsapp-web.js/src/structures/Message.js` in place on every `npm install` (fixes @lid message IDs and media downloads). Patched markers (`// PATCH_WWEBJS_*`) are expected; if you upgrade `whatsapp-web.js`, the patch may silently no-op and media/lid bugs return.
- **No per-entity Mongoose models.** All app data lives in one `json_store` Mongo collection, one document per store key (`assistants`, `courses`, `lecturers`, `schedules`, `reports`, `globalConfig`). Repositories (`repositories/`) hold an in-memory cache: `read()` is synchronous, `write()` updates the cache synchronously then persists to Mongo asynchronously via an ordered promise chain. Runtime source of truth is Mongo, not the JSON files.
- `await initRepositories()` must run after `connectDB()` and before any `repo.read()` — done in `server.js` start and in every script that touches repos (copy that pattern; seeding skips Mongo docs that already exist).
- Root JSON files (`config_asisten.json`, `courses.json`, ...) are legacy seed inputs only; `config/paths.js` also falls back to a `bak/` dir for them.
- **WhatsApp bot is Windows-only**: Puppeteer `executablePath` is hardcoded to `C:\Program Files\Google\Chrome\Application\chrome.exe`, and zombie-browser cleanup uses `taskkill`/PowerShell (win32 only). Don't assume it runs elsewhere.
- `.wwebjs_auth/` is the WhatsApp session — never commit or delete it (deletion forces QR re-scan). `hide/` is a manual session backup, also ignored.
- `.gitignore` patterns `scratch*`, `test-*.js`, `debug*` are intentional: root-level files like `test-gemini-models.js` and `scratch_inspect.js` are untracked local scratch, not app code.
- `nodemon` ignores `*.json` — editing seed JSON files won't restart the dev server.
- `services/messageGeneratorService.js` contains a hardcoded fallback Gemini API key (alongside `GEMINI_API_KEY`). Don't copy that pattern and don't commit new secrets.

## Architecture

- `server.js` — wiring only (routes, middleware, Mongo, WhatsApp init); no business logic.
- Layering: `routes/` → `services/` → `repositories/`. Async route handlers must be wrapped in `asyncHandler` from `routes/_helpers.js`; throw `config/AppError`. `multerErrorHandler` + `globalErrorHandler` are mounted last in `server.js`.
- WhatsApp intake: `services/whatsapp/messageHandler.js` filters messages by `globalConfig.system.group_id`, parses captions with regexes (`Hari/Tanggal:`, `Mata kuliah:`, ...), requires an image unless it's a "libur" report. Client singleton (`whatsappClient.js`) has self-healing (stale Chrome locks, orphan processes, cache purge that preserves credentials).
- Cron reminders: `node-cron` at `0 20 * * *` — **server local time**, not WIB-adjusted.
- Document generation: `services/exportService.js` (docxtemplater + pizzip for DOCX, ExcelJS for XLSX) reads fixed template files from `templates/`; if a template changes, exports change.
- Uploads: multer to `laporan_images/YYYY/MM/DD/`, images only, 5 MB max.

## Git

- Current work branch: `feat/ze-json-parser-benchmark`; `main` is the default. History uses Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).

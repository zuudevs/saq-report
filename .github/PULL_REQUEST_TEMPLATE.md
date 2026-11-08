# Pull Request

> Branch discipline: no direct pushes to `main`. Title follows Conventional Commits:
> `type(scope): subject` — types: feat | fix | perf | refactor | test | docs | build | ci | chore | style | revert.
> PR descriptions may be written in Indonesian (Bahasa Indonesia).

## Rationale

<!-- WHAT changed and WHY.
     Reference the TASKS.md task ID (e.g. P0-2, P4-3).
     If a technique comes from a paper, cite the DOI and keep it in sync with the
     Doxygen @cite comments in the code (corpus: out/rag/<DOI>.chunks.json). -->

## Changes

<!-- Key files touched (path -> change). Keep it short; details live in commits. -->

## Measurement Evidence

<!-- REQUIRED for performance-affecting changes. Delete this section only for
     docs/chore-only changes.

- Record (validated): `out/measurements/<run_id>-...-record.json`
- Raw exhibit: `out/raw/<run_id>/...`
- Validator: `PASS/FAIL` — output of `python scripts/measurement-schema/validate.py <record>`
- Baseline -> Candidate: `<short-hash>` -> `<short-hash>` (same preset, same corpus)
- Site: `dev_device` | `saq_server` (host introspection attached in the record)
- Compare rule: numbers compared only in-situ; never across machines/presets/hashes/corpora -->

## Checklist

- [ ] `ctest` green on every touched preset
- [ ] `native-sanitize` (ASan/UBSan) pass for new C++ paths (correctness only, never benchmarked)
- [ ] Scalar <-> fast-path differential test green (byte-identical, edge cases included)
- [ ] Doxygen `@cite <DOI>` comments present on new core code / benchmark / test code
- [ ] Every measurement result carries its `rationale` (purpose + basis_papers), in the
      record AND synchronized with the code comments
- [ ] Conventional Commits followed
- [ ] `PLANS.md` / `TASKS.md` updated if a decision changed

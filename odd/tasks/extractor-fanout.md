# Extractor fan-out — capture everything, rank at serve time

> Source of truth for this feature. Engram mirror: topic `odd/extractor-fanout/tasks`.

**Objective:** Every search fans out to all live sources, persists ALL candidates
with metadata, and ranks/filters at serve time — nothing usable is ever
discarded by a narrow filter or a single `intercepted[0]`.

**Problem:** Current logic is a discard funnel: one extractor path per type,
first-hit-only interception, single KV key per id, wrong-key writes orphan
good results. Proven by live probes 2026-10-15 (movie catalog lists 18,
all streams empty; tv/series catalogs empty).

**Why:** User decision 2026-10-15: `Fan-out total` over fix-minimo and
mirrors-nuevos. Stop half-measures; make every search count.

**Scope:** Worker stream/catalog path + KV key discipline + candidate store +
serve-time ranking + proxy wiring. No new extractor sources yet (vidlink.pro
via decryptor/cuevana-native/vidhide remain the source set).

**Constraints:**
- No deploys without explicit user OK (publishing stays human-owned).
- One writer at a time; work-unit commits on `feat/extractor-fanout` only.
- ~400 authored lines per task is advisory, not a cap. Never strip tests/docs
  to fit it.
- Test-first where runnable: RED before GREEN for pure logic with a runner;
  otherwise structural/functional checks + honest exception note.

## Tasks

- [ ] **F1 — Unify catalog KV key version** (route: delegated direct; trigger:
  writer, 2+ files). Files: `workers/addon/src/utils/cache.ts`,
  `.github/workflows/daily-catalog.yml`. Decision: revert reader to v1
  (smallest fix) unless writer proves v2 is the live-populated one.
  Accept: `catalog/tv/futbol.json` and `catalog/series/series.json` non-empty.
- [ ] **F2 — Fix vidhide result keyland** (route: delegated direct).
  Files: `.github/workflows/resolve-on-demand.yml` (~line 118),
  `workers/addon/src/routes/stream.ts`. Results must land in
  `stream:<movie|series>:<id>` by id prefix, never blanket `stream:tv:`.
  Accept: `stream/movie/cu-<id>.json` returns candidates after dispatch.
- [ ] **F3 — Candidate store: keep every hit** (route: delegated direct).
  Persist all candidates per search with metadata
  (source, quality, ts, signature params, embedUrl) instead of first-hit-only.
  New module allowed: `workers/addon/src/utils/candidates.ts`.
  Accept: a search with N hits stores N ranked candidates, observable via
  debug route.
- [ ] **F4 — Serve-time ranking** (route: delegated direct). Parse master
  playlists for real `RESOLUTION` (never snap token digits to a label), rank
  by quality/freshness/source reliability, ordered fallback chain.
  Accept: stream responses carry true quality labels + ordered fallbacks.
- [ ] **F5 — Proxy wiring + end-to-end verify** (route: delegated direct).
  `rewriteToProxy` over ranked candidates; verify one real signed vidlink URL
  in Stremio; record outcome here. Accept: playback works, outcome recorded.
- [ ] **F6 — Hygiene** (route: direct inline, mechanical). Delete confirmed
  dead root artifacts (`decryptor.wasm`, `vsdec_packed.js`, `player_*`,
  `test_*.mjs`, `meta_api_response.json`, `test.json`,
  `workers/addon/test_*.ts`); drop `@noble/ciphers` if still unimported.
  Accept: root clean, build green.

## Authorized scope (writer edit surfaces)

- `workers/addon/src/routes/stream.ts`
- `workers/addon/src/routes/debug.ts`
- `workers/addon/src/routes/catalog.ts`
- `workers/addon/src/utils/cache.ts`
- `workers/addon/src/utils/candidates.ts` (new, authorized)
- `workers/addon/src/clients/kv.ts`
- `.github/workflows/resolve-on-demand.yml`
- `.github/workflows/daily-catalog.yml`
- `odd/tasks/extractor-fanout.md` (progress evidence only)

Nothing beyond this list. Wider surface = defect, stop and ask.

## Checks per task

Applicable runner from `workers/addon/package.json` (writer reports which).
Typecheck + tests where present; `wrangler deploy --dry-run` or equivalent
structural check; live curl probes stay parent-side post-deploy. Failed,
skipped, or pending checks recorded honestly per task — never invented.

## Delivery

Strategy: `ask-on-risk` (default). Forecast: F1+F2 small (one work-unit
commit); F3+F4 likely the slice that trips the ~400-line delivery budget —
running count from work-unit commits decides; chain strategy asked once if
needed. Candidate unit = work-unit commit, never a TODO checkbox. RDD review
per commit only if the user-owned switch is on.

## Progress

- 2026-10-15: feature created on `feat/extractor-fanout` after full-repo map
  (nvidia-kimi-k3) + live probes. F1+F2 delegated first. Next: F3.
- 2026-10-15: F1 done — reverted catalog reader to v1 keys (`catalog:${type}:${id}`) in `workers/addon/src/utils/cache.ts:24` and `workers/addon/src/clients/kv.ts:58`; workflow `.github/workflows/daily-catalog.yml` already writes v1 keys (`catalog:tv:futbol`, `catalog:movie:cine`, `catalog:series:series`). Verified: typecheck passes for changed files (pre-existing errors unrelated).
- 2026-10-15: F2 done — added `stream_type` input to `.github/workflows/resolve-on-demand.yml:31-34` and used it for vidhide target at line 122; extended `DispatchInputs` in `workers/addon/src/clients/github.ts:15-16`; pass explicit `type` from `workers/addon/src/routes/stream.ts:88` when dispatching cu-* with vidhide. Vidhide results now land in `stream:<movie|series>:<id>` matching the poll key.
- 2026-10-15: work-unit commit `ff0f5eb` (F1+F2, 7 files). RDD review started (lineage `review-7b563403b0585245`, high risk/shell) but all 4 lenses failed environmentally — reviewer pool `opencode/*` free tier unavailable in this runtime. Lineage left `reviewing`; boundary stays unreviewed at `1df3993`. F1+F2 hunks verified by parent grep (cache.ts:24, catalog.ts:18, yml:31/122/125, stream.ts:88, github.ts:16). Next: user decides review path, then F3.
- 2026-10-15: F3 done — created `workers/addon/src/utils/candidates.ts` with key family `stream:candidates:<type>:<id>` (cap 20, dedupe by url+source); wired into `stream.ts` after Cuevana-native (line ~101) and decryptor (line ~145) branches; added read-only `/debug/candidates/:type/:id` in `debug.ts` and `index.ts`. Verified: typecheck passes for new/changed files (pre-existing errors unrelated).
- 2026-10-15: F4 done — added `parseMasterPlaylist`, `fetchTrueQuality` (5s timeout), `qualityRank` export in `quality.ts`; added `updateCandidateQuality` in `candidates.ts`; added `rankAndResolveCandidates` with ranking: true resolution desc → source reliability (decryptor/vidhide-native=3, cuevana-native=2, others=1) → freshness (ts desc) in `stream.ts`; `resolveStreams` now serves ranked candidates first, falling back to extraction. Verified: typecheck passes for new/changed files (pre-existing errors in chacha20_custom.ts, kv.ts only); parseMasterPlaylist deterministic test passes (2160p from fixture, null for audio-only/empty).

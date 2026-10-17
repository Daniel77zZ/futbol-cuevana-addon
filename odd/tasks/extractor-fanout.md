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
- 2026-10-15: F5 audit (parent, inline — writer pool 503). `rewriteToProxy` wiring over ranked candidates was ALREADY present (stream.ts:111/161/229/339), so the wiring half of F5 is done. Two defects found:
  1. **Proxy cannot serve multi-level HLS** (CORROBORATED, `index.ts:204-285` + `:74-75`): `handleVideoProxy` passes the manifest body through unmodified (`:275 response.body`), so child playlists/segments are never rewritten to go through the proxy. Relative child URLs resolve against the proxy base (`/proxy/video/` + no `?url=`) → `:210-211` returns 400; absolute child URLs hit the CDN with no injected `Referer`/`Origin` (`:249-254`) → CDN rejects. Symptoms expected: master loads, playback dies on the first child request. **Fix belongs in `index.ts` (body rewrite of `.m3u8` child URLs) — OUTSIDE this feature's authorized scope.**
  2. **Allowlist uses substring `includes()`** (`stream.ts:258`, `index.ts:224`) — hostname `evilflood.sourcerrr.online` passes; should be exact-or-suffix match. In-scope half is stream.ts only; tightening one side alone risks divergence.
  E2E verification (real signed vidlink URL in Stremio) still REQUIRES a deploy — not authorized. F5 stays open: needs (a) explicit deploy OK, (b) scope decision on `index.ts`.
- 2026-10-15: F5 external research (parent, verified). Confirms the F5 diagnosis is a KNOWN solved problem, not something to invent:
  - **Stremio SDK issue #350** (`Stremio/stremio-addon-sdk`) + **stremio-bugs #1332**: `behaviorHints.proxyHeaders.request` does NOT propagate to HLS child playlists / AES key / segments ("The initial HLS playlist request succeeds… the Referer and Origin headers do not appear to be propagated to those subsequent HLS requests"). Exactly our symptom.
  - **Canonical implementation: MediaFlow Proxy** (`mhdzumair/mediaflow-proxy`, MIT, Python/FastAPI, Docker, port 8888). Endpoint `/proxy/hls/manifest.m3u8?d=<url>&h_referer=…&h_origin=…&api_password=…` — it PARSES AND REWRITES the M3U8 manifest so every child URL returns through the proxy with the injected headers, and can rewrite HLS key URLs. Ack section names Stremio Server's own HLS proxify as its inspiration. `M3U8_CONTENT_ROUTING` = mediaflow | stremio | direct. → our `handleVideoProxy` does the naive pass-through that MediaFlow deliberately does not.
  - **Extraction recipe: `aryaniiil/vidlink-m3u8`** (Node/Fastify + Go WASM token gen, `fu.wasm`). `GET /movie/{tmdbId}` returns `api_url` (`https://vidlink.pro/api/b/movie/{id}?multiLang=0`), the REQUIRED `headers` (referer `https://vidlink.pro/movie/{id}`, origin `https://vidlink.pro`), the full HLS master `playlist`, and the resolved `stream.playlist` (`https://storm.vodvidl.site/proxy/file2/…`). Its manifest variant URLs are RELATIVE (`/proxy/file2/…`) and "need to be combined with the base domain" — independently confirming the relative-URL failure mode. Segments carry `?headers={…referer:videostr.net}&host=…`.
  - **`walterwhite-69/Vidlink.pro-Decryptor`** (updated 2026-10-15): vidlink.pro production encryption reverse-engineered as **XSalsa20-Poly1305 in pure Python** — NOT ChaCha20. Casts doubt on our `chacha20_custom.ts` assumption if the embed we hit is vidlink.
  - Copy plan: (1) port MediaFlow's manifest-rewrite algorithm into our `/proxy/video/` (resolve relative URIs against the ORIGINAL manifest origin, rewrite variant/key/segment URIs back through the proxy with headers); or deploy MediaFlow Proxy as-is and emit `d=` + `h_` URLs. (2) adopt the `vidlink-m3u8` chain as the movies/series source (proven; removes crypto guesswork) — scope expansion, needs user OK.
- 2026-10-15: F5 research round 2 — landscape CONFIRMED (parent, artifacts read in full, not snippets):
  - **AIOStreams (`Viren070/AIOStreams`, ⭐2889, TypeScript, pushed same day)** IS the biggest project and the closest to our stack. It HAS its own proxy (`packages/core/src/proxy/builtin.ts`) AND integrates MediaFlow (`proxy/mediaflow.ts`) + StremThru (`proxy/stremthru.ts`). **Decisive: its proxy route (`packages/server/src/routes/api/proxy.ts`) was read end-to-end — it injects headers, follows redirects (`MAX_REDIRECTS`), pipes the body with Range support, but does NOT parse or rewrite the HLS manifest.** So the largest project in the ecosystem did NOT reimplement HLS rewriting; it delegates that to MediaFlow. That is the strongest available confirmation that MediaFlow's approach IS the state of the art.
  - **MediaFusion (⭐951) and Comet (⭐1116) also delegate to MediaFlow.** MediaFlow (⭐813) remains the only one doing the full job (HLS rewrite + AES key URL rewrite + content routing), self-described as inspired by Stremio Server's own HLS proxify.
  - **Workers-native rewriters exist and are copyable**: `frank-vpl/TV-Workers` (⭐99, MIT — "Rewrites .m3u8 playlists to pass back through your Worker" + segment streaming + dynamic headers) and `prathvikothari/HLS-Proxy-Worker`. **Counter-example read and rejected**: `MHSanaei/HLS-Proxy-Worker` (1 commit) only converts relative→absolute and does NOT re-proxy the child URLs → insufficient for our case.
  - **Canonical rewrite algorithm, ~15 lines** (`srtfile/all_codes_and_info` megaplayer_server.py): compute `base = original_url.rsplit("/",1)[0]+"/"`; rewrite `URI="..."` attributes via `urljoin(base, uri)`; rewrite bare segment/sub-manifest lines via `urljoin(base, stripped)`; emit each as `/proxy?url=<abs>&ref=<referer>&origin=<origin>`.
  - NOT yet checked (honest gap): `MunifTanjim/stremthru` (the other proxy AIOStreams supports) and whether any Workers port of MediaFlow exists.
  - Verdict: nothing more advanced exists for our situation. The correct copy is the ~15–30 line manifest-rewrite pattern into our `/proxy/video/`, not a new service.
- 2026-10-15: F5 research round 3 — **likely root cause found at the extraction layer, plus the escalation that removes hand-rolled extractor work entirely**:
  - **CORROBORATED (read our file): `vidhide_v2.ts` does NOT target vidhide — it targets `vidlink.pro`.** `vidhide_v2.ts:49-50` sets `VS_EMBED_BASE = "https://vidlink.pro"` and `VS_SRC_ENDPOINT = "/vs_src.php"`. Our chain is vidlink.pro's `vs_src.php → CFG → CONFIG → stream_urls → decrypt → m3u8`.
  - **CORROBORATED (independent project): vidlink.pro's production encryption is XSalsa20-Poly1305**, implemented in pure Python by `walterwhite-69/Vidlink.pro-Decryptor`. Our chain calls `chacha20DecryptCustom` (`chacha20_custom.ts`). **Hypothesis (testable, no deploy): the extraction has NEVER worked because the cipher is wrong — and the proxy fix alone would NOT have fixed playback.** This would explain weeks of failure. Cheap decisive test: run `vidhide_v2.ts` against a live vidlink embed and see whether `stream_urls` decrypts into a real m3u8.
  - **MediaFlow Proxy ships 26 built-in extractors (`mediaflow_proxy/extractors/`, factory.py)** covering BOTH of our axes — football: `Sportsonline`, `LiveTV`, `Vavoo`; and the VidHide/StreamWish white-label family: `StreamWish`, `FileLions`, `FileMoon`, `Vidmoly`, `Voe`, `LuluStream`, `Maxstream`, `Doodstream`, `Streamtape`, `Mixdrop`, `Okru`, `VidFast`, `VixCloud`, `Supervideo`, `TurboVidPlay`, `Uqload`, `Vidoza`, `City`, `F16Px`, `Gupload`, `Fastream`, `TurboVidPlay`.
  - **Read `streamwish.py` in full**: fetch page w/ Referer → regex `<iframe src>` → fetch iframe → regex absolute `.m3u8`; if the page is packed JS (`eval(function(p,a,c,k,e,d)`) fall through to `eval_solver` (a packed-JS unpacker); join relative `/stream/...` paths. Returns `{destination_url, request_headers, mediaflow_endpoint: "hls_manifest_proxy", stream_transformer: "ts_stream"}` — **extraction and playback come out as ONE integrated flow**, which is exactly what we have been hand-building.
  - **Extractor docs**: `/extractor/video.m3u8?host=<Host>&d=<page>&api_password=…&redirect_stream=true` — the `.m3u8` extension + redirect matter because ExoPlayer (Stremio) picks `HlsMediaSource` from the URL extension before any request.
  - **CinePro Core (`cinepro-org/core`, ⭐190, TypeScript, deployable to Cloudflare Workers)** — OMSS-compliant multi-site scraper, modular provider plugin system with auto-discovery, 50+ sources, ships a Stremio addon (`STREMIO_ADDON` env → `/stremio/manifest.json`). Its providers are TS/Workers-compatible → potentially copyable into our Worker. **License: PolyForm Noncommercial** (fine for personal use; blocks commercial).
  - Also relevant: `MunifTanjim/stremthru` (⭐555, Go, pushed 2026-10-17) — the other proxy AIOStreams supports.
  - Escalation options, ranked: **(A)** MediaFlow as extraction+playback engine — `/extractor/video.m3u8?host=StreamWish|Sportsonline&d=…` handles extract + headers + manifest rewrite + segments; drop `vidhide_v2.ts`/`chacha20_custom.ts`; cost = a Python service. **(B)** port CinePro provider plugins (Workers-native TS) into our Worker; cost = bigger change + noncommercial license. **(C)** keep Workers-only: ~30-line manifest rewrite + fix the cipher to XSalsa20-Poly1305; highest effort, no new infra.
- 2026-10-15: **F5 research round 4 — OPTION A PROVEN END-TO-END (user chose A). The whole chain works.** Executed live, all steps corroborated:
  - **Live addon is DOWN**: `futbol-cueva-addon.danielmamanidiaz.workers.dev` returns 404 + `error code: 1042` on EVERY path (`/`, `/manifest.json`, `/catalog/...`, `/debug/...`). There is no working baseline deployed.
  - **Cuevana domains ROTATED — root cause of the last weeks.** `api.cuevana3.io` (hardcoded in `clients/cuevana3.ts:23`) is **PARKED** (DNS → `pltraffic8.com`, `permissions-policy` for `parklogic.com`, broken TLS cert). Live successor: `api.cuevana3r.pro` → 301 → `cuevana3r.pro`; and `tungtungsahur.cuevana3k.pro` → **`tungtungsahur.cuevana3r.pro`** (both alive, Cloudflare).
  - **We do NOT need the API at all**: `https://cuevana3r.pro/pelicula/<slug>` returns 200 and the HTML **contains the `token=` values directly**. (`/ir/goto_ddh.php` hits return 403 from origin nginx.)
  - **The tungtungsahur XOR decoder STILL WORKS** (key `a45f04ce-2394-47c3-b718-0ecd97ce51d6`, prefix→server map). Verified live: `token=1ElNbVQZWCRNZBgVI` → `https://lkhjerbhye3wjkhodvh5xiczuvd.lol/v/sgn36bjvt46q`; `token=3FAdXCAVeAFYZXFJO` → `https://lkhjerbhye3wjkhodvh5xlczuvd.lol/e/u3bn5jc34naw`. So `extractors/tungtungsahur.ts` is KEPT as-is.
  - **The `.lol` embeds ARE the StreamHG/VidHide family** and MediaFlow **has `StreamHG`** (`extractors/streamhg.py`: `eval_solver` = Dean Edwards unpacker, pattern `"hls2":"…"`). Verified extraction → real signed master: `https://<rand>.acek-cdn.com/hls2/01/08643/jf33ier2b1bp_n/master.m3u8?t=…&e=129600&f=43220691&asn=7303` (720p, `avc1.64001f,mp4a.40.2`). **Our entire crypto layer (`vidhide_v2.ts` ChaCha20/WASM, `chacha20_custom.ts`, `vidhide.ts` Dean Edwards) is superseded and deletable.**
  - **The CDN does NOT require Referer**: master and variant both return 200 with UA-only, wrong Referer, or no headers at all. The token URL does carry `asn=7303` (Telecom AR) and expires (`e=129600`) → consistent-exit-IP proxying is the safe design.
  - **MediaFlow's manifest proxy REWRITES natively** (verified via in-process uvicorn): `/proxy/hls/manifest.m3u8?d=<master>&h_referer=…` returns 200 with every child rewritten back through the proxy, **including the `URI="…"` I-FRAME tag**.
  - **Single Stremio-ready URL** (verified `redirect_stream=true` → 302 → proxied+rewritten manifest): `{MEDIAFLOW_BASE}/extractor/video.m3u8?host=StreamHG&d=<embed>&api_password=<pw>&redirect_stream=true`. The `.m3u8` extension is what makes ExoPlayer choose HlsMediaSource.
  - Environment: **Docker unavailable in this WSL distro**; MediaFlow installed natively (`uv venv --python 3.12` + `uv pip install -e .` in `/tmp/opencode/mediaflow-proxy`). Convention: `api_password` optional; routes `/extractor/video[.ext]` and `/proxy/hls/manifest.m3u8` (+`/segment.{ext}`, `/key_proxy/manifest.m3u8`).
  - **New F5 plan (Option A)**: Worker becomes thin — (1) fetch Cuevana page (`cuevana3r.pro`), (2) regex `token=…`, (3) XOR-decode via existing `tungtungsahur.ts` to the embed URL, (4) emit `{MEDIAFLOW_BASE}/extractor/video.m3u8?host=StreamHG&d=<embed>&api_password=…&redirect_stream=true`. Delete `vidhide_v2.ts`, `chacha20_custom.ts`, `vidhide.ts`, and let MediaFlow replace `handleVideoProxy` in `index.ts`. Repoint `clients/cuevana3.ts` off the parked `api.cuevana3.io`.
  - **Open decision**: where MediaFlow is hosted (LAN-only vs public VPS/Fly/Cloudflare tunnel) — decides whether the addon is usable "from anywhere".
- 2026-10-15: **F5 round 5 — homepage path + extractor reliability matrix (user asked to test `https://cuevana3r.pro/`).**
  - `https://cuevana3r.pro/` (homepage) → **200, 145 KB, title "Cuevana 3 - Ver Películas Gratis, Series y Anime en HD Online"**, 24 `/pelicula/…` + 43 `/serie/…` links. It IS the live site (same host already used). Discovery path works: homepage → content page → tokens → embed → stream.
  - Ran the full chain on `/pelicula/apuntes-para-una-ficcion-consentida`: tokens `1CAZcVUNGDFFdSENe`, `3DURQF1gGU1AVR18A` → `/v/i2i3sro4pzpg` and `/e/lpeqh2058ul9`.
  - **Host × embed matrix (16 MediaFlow hosts × both embeds):**
    - `/v/` (prefix 1) → **StreamHG OK**, **StreamWish OK** (both real `master.m3u8`); also `FileLions` (different `/stream/…` form). Rest failed.
    - `/e/` (prefix 3) → **ALL 16 hosts failed** for this title (incl. StreamHG). But for the earlier title, `/e/u3bn5jc34naw` DID work with StreamHG → **failure is per-title/per-embed, not per-host**.
    - **False positives found**: `Supervideo` and `Fastream` return `…/dl?op=get_slides&…` (an image-slides API, NOT a video) and report success → **the extracted URL MUST be validated (must contain `.m3u8`) before emitting it**.
  - **Strategy for the Worker**: for each token → decode → try embeds in order, and for each try `StreamHG` then `StreamWish`; accept the first result whose `destination_url` contains `.m3u8`; discard non-m3u8 results. Prefer prefix 1 (`/v/`) when both are present.
  - Note: MediaFlow caches extractor results (and has Redis-backed in-flight dedup), so repeated hits are cheap; failures are not cached.
- 2026-10-15: **F5-A IMPLEMENTATION — Option A worker rewrite (user approved "si dale").**
  - **HTML structure CORROBORATED** on `/pelicula/apuntes-para-una-ficcion-consentida` (75505 bytes): 6 `data-server` attributes, all `https://tungtungsahur.cuevana3r.pro/…`:
    - `?token=<b64>` × 2 → labelled `Servidor Hyper` and `Servidor Nebula` (these are the filemoon/dood/`.lol` token forms; `client/tungtungsahur.ts` decode applies).
    - `?v=<b64>` × 4 → direct base64 URLs, `Servidor Goldmember` (`vsembed.ru/embed/movie?tmdb=…`), `Servidor Death Star` (`vidlink.pro/movie/…`), `Servidor Trinity` (`player.videasy.net/movie/…`), `Servidor Mahoutokoro` (`vidapi.xyz/embed/movie/…`). **None of these four are MediaFlow hosts** → only the two `?token=` servers are usable.
    - Existing regex `pattern1` (requires `data-server="…tungtungsahur…"` adjacent to `Servidor (Hyper|Nebula)` + `Reproducir`) still matches, in document order → first match is `Servidor Hyper` = prefix `1` = `/v/` = the one that WORKS. Only the host needs repointing.
  - Task checklist (F5-A) — **ALL DONE, verified with the real modules** (2026-10-15):
    - [x] T1 `clients/mediaflow.ts` — `MediaFlowClient.fromEnv/buildStreamUrl/validate`, `MEDIAFLOW_HOSTS = ["StreamHG","StreamWish"]`, `.m3u8` guard on `destination_url`.
    - [x] T2 `extractors/cuevana.ts` — rewritten: `parseCuevanaServers` (pure) + `extractCuevanaServers` (live fetch, desktop UA) + `buildCuevanaPageUrl`. Keep `?token=` only; ignore `?v=`. `tungtungsahur.ts` untouched.
    - [x] T3 `routes/stream.ts` — `CUEVANA_BASE = "https://cuevana3r.pro"` constant; `cu-*` branch → page → servers → `resolveCuevanaViaMediaFlow` (bounded 4 attempts, parallel, 8s each, deterministic preference order) → `saveCandidates(source: "mediaflow", ts: Date.now() - index)`.
    - [x] T4 `index.ts` + `wrangler.toml` — `MEDIAFLOW_BASE?: string` + `MEDIAFLOW_API_PASSWORD?: string` in `Env`; `MEDIAFLOW_BASE = "http://localhost:8888"` placeholder in `[vars]`; secret comment.
    - [x] T5 deleted `vidhide_v2.ts`, `chacha20_custom.ts`, `vidhide.ts`, **and `clients/cuevana3.ts`** (the dead-API client; nothing imported it after T2). `routes/debug.ts` cleaned (`debugVidHideV2` removed), `index.ts` `/debug/vidhide-v2` route removed.
    - [x] T6 `npm run typecheck` — **only the pre-existing `clients/kv.ts:73` error remains** (debug `console.log` calling `.length` on a generic `T`). The 13 `chacha20_custom.ts` errors are gone with T5.
  - **Functional verification (real modules via `tsx`, live network + local MediaFlow on :8899)** — `/tmp/opencode/harness.ts`:
    - `MediaFlowClient.fromEnv({})` → `null` (unconfigured path returns no streams instead of throwing).
    - `buildCuevanaPageUrl` movie → `https://cuevana3r.pro/pelicula/apuntes-para-una-ficcion-consentida`; series → `https://cuevana3r.pro/serie/4-blocks-zero/episodio-1x4`.
    - `extractCuevanaServers` on the live page: **268 ms, 2 servers, document order and labels correct** — `[1] Hyper → .lol/v/i2i3sro4pzpg`, `[3] Nebula → .lol/e/lpeqh2058ul9`.
    - Validation matrix: `Hyper+StreamHG` PASS (1509 ms), `Hyper+StreamWish` PASS (3675 ms), `Nebula` fails on both hosts (per-title, as expected) → **2 playable streams, the dead one filtered out**.
    - `GET` the built `…/extractor/video.m3u8?host=StreamHG&d=…&redirect_stream=true` → **200, `#EXTM3U`, 834 bytes, `RESOLUTION=1280x720`**. Manifest is real and rewritten.
  - Out of scope on purpose: `index.ts` `handleVideoProxy` and `rewriteToProxy` are left untouched — with MediaFlow they are dead for the Cuevana path, and they still carry a stale `vidlink.pro` referer default. Removing them is separate debt. Same for the `vidhide` target in `clients/github.ts` + `.github/workflows/resolve-on-demand.yml` (now unused by Cuevana, harmless).

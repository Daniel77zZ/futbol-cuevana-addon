# Stremio addon — fútbol + Cuevana, sin anuncios

> **This file is the source of truth.** Engram has been rejecting writes this
> session (`could not confirm session registration` — two sessions registered
> for this project cause write ambiguity). Do not depend on memory to resume
> work. Read this file first.

**Goal:** Watch football (Fútbol Libre) and Cuevana content in Stremio, ad-free,
good quality, resolving automatically.

**Live addon URL:** `https://futbol-cuevana-addon.danielmamanidiaz.workers.dev`

---

## Status against the goal

| Requirement | State | Evidence |
|---|---|---|
| Football streams, ad-free | ✅ **works** | live HLS from `*.fubo18.com`, run `37231925358` |
| Auto-resolve (football) | ⚠️ **2nd click only** | Worker polls KV 30s, GH run needs ~45s |
| Good quality | ❌ **fake** | quality was digits scraped out of the HLS auth token |
| Cuevana movies/series | ❌ **never worked** | 0 `stream:movie:cu-*` keys have EVER been written |

---

## Architecture (verified end to end)

```
Stremio  ──►  Worker (Cloudflare)         catalog:tv/movie/series from KV
                │                          cache hit ──► 0.18s, done
                └──► GitHub Actions workflow_dispatch
                        │  ~45s: fresh VM, installs Chromium + Playwright
                        ▼
                     extractors/main.py --type futbol|cine|series
                        │
                        ▼  Playwright + stealth → page.on("request")
                        │  grab the video manifest the page's JS requests
                        ▼
                     writes {hls, quality, sourceUrl, id, type, ts} → KV
                │
                └──► polls KV every 2s × 15  ──► Stremio plays
```

The extractor does **not** crack anything. It opens the page in a real browser and
watches which media request it fires. The URL does not exist in the HTML — it is
built by page JavaScript at runtime.

---

## Football — how it works

- Catalog `embedUrl` looks like
  `https://futbollibrefullhd.org/embed/eventos.html?r=<base64>`
- `r=` decodes to `https://tvf90/com/1.php?stream=espn1_nl` — note the host mangles
  `.com` into `/com` on purpose to defeat domain greps.
- Page JS repairs it, loads the player, player requests:
  `https://am91cm5leq.fubo18.com/disney1/mono.m3u8?token=<40hex>-<flag>-<ts>-<ts>`
- Token trailing epochs are ~18000s apart (5h validity). Code never parses it,
  it only requires the literal `token=` to exist (`extractors/shared/http.py:145`).

**Known waste:** `extractors/tvf90.py:49-78` burns ~40s waiting for an iframe and
clicking overlays *after* the HLS URL was already captured at
`extractors/tvf90.py:43`. The iframe only feeds fallback paths that are not
needed once interception succeeded.

---

## Cuevana — how it actually works (verified by probe, never in code)

Extraction chain, all of it plain and unobfuscated:

```
https://cuevana3k.pro/pelicula/doing-life
  │  HTML contains:  <li data-server="…">
  ▼
tungtungsahur.cuevana3k.pro/?v=<base64>      gateway; subdomain ROTATES per movie
  │  base64-decodes to one of 4 mirrors
  ▼
vsembed.ru · vidlink.pro · player.videasy.net · vidapi.xyz
  │  all four serve the SAME film, keyed by TMDB id (tmdb=1458857)
  ▼
signed media URL, e.g.
https://noon.mooncase.online/mp/resource/<id>.mp4?sign=…&t=…&host=…
```

`cuevana3k.pro/js/movie-player.js` is **84 lines, no obfuscation, no crypto**: it
reads `element.dataset.server`, stores
`{type, location, embed}` in a plaintext cookie named `player`, then redirects.

### Mirror reachability (probed 2026-10-04)

| Mirror | Result |
|---|---|
| `vsembed.ru` | `about:blank` — dead |
| `vidapi.xyz` | nothing |
| `player.videasy.net` | `ERR_CERT_AUTHORITY_INVALID` |
| **`vidlink.pro`** | ✅ **serves a real signed MP4** |

`yt-dlp` handles **none** of them (`ERROR: Unsupported URL`). This is why the
existing Cuevana extractor can never work — it reads `item.embedUrl` (which the
scraper never emits) and hands `yt-dlp` a plain detail page.

---

## Bugs found and fixed (committed)

| Commit | Fix |
|---|---|
| `dc15c21` | `GH_REPO` was template placeholder `user/…` → every dispatch would 404. Closed script injection via `env:` indirection. Added input validation (`id` becomes a KV key, so `:`/`/` could address arbitrary keys). Added `permissions: contents: read`. Fixed `dry_run` boolean-vs-string. |
| `e21a82e` | **dispatch contract mismatch** — Worker sent `{type, id, sourceUrl}`, workflow declares `{target, id, url}` → GitHub `422 Unexpected inputs`. Also mapped Stremio `tv/movie/series` → workflow `futbol/cine/series`. |
| `890c63d` | **extractor never wrote `ts`** → `isFresh(undefined)` false forever → cache permanently stale → every play click re-dispatched a run and timed out at 30s. Proved: same key answers 0.18s instead of 32s. |
| `9cba3fa` | `normalizeQuality` returned raw input → token digits became the Stremio title. Now returns `auto`. |

Deployment secrets: `GH_TOKEN` set (fine-grained PAT, Actions: read+write, repo-scoped).
`TMDB_API_KEY` is **not** set — it is optional, it only affects metadata/posters
(`workers/addon/src/routes/meta.ts:16` guards it).

---

## Open work, in the order it should be done

### 1. Quality is still a guess — football
The captured `mono.m3u8` is a **variant** playlist. Real resolution lives in the
**master** playlist's `#EXT-X-STREAM-INF:BANDWIDTH=…,RESOLUTION=…`. Those strings
appear **zero times** in the repo — no playlist body is ever fetched.
Interception catches every request but filters to `fubo18.com`+`.m3u8`+`token=`
and consumes only `intercepted[0]`. Need: keep all m3u8 hits, fetch the master,
parse the highest variant. Do **not** snap 1697→1440p; that would be a lie.

### 2. Cuevana resolver — does not exist
Required, all new work:
- extractor must target `vidlink.pro` (only live mirror), served from the
  `data-server` value
- interceptor must accept **`.mp4`**, not only `.m3u8` — current filter misses Cuevana entirely
- the scraper must emit `embedUrl`; today it emits `sourceUrl` which
  `workers/addon/src/routes/stream.ts:63` never reads (0/18 items have `embedUrl`)
- scraper only reads one page → 18 movies instead of thousands
- domain mismatch: catalog scraped from `cuevana3k.pro`, `buildSourceUrl()` builds
  `cuevana3.ch` (`workers/addon/src/routes/stream.ts:14-16`)

### 3. THE blocking unknown for Cuevana
The captured MP4 returns **403 to `curl` with every Referer tried**. Signature
carries `sign=`, `t=`, `host=`, `headers=`. A same-session vs fresh-session
replay test was run but was **inconclusive** (the filter matched a jwplayer ping
GIF instead of the MP4).

This decides the architecture:
- **replayable outside the session** → hand the URL to Stremio directly (simple)
- **bound to session cookie or IP** → the Worker must **proxy the video bytes**,
  which changes bandwidth, cost and CPU limits

### 4. First-click UX
Worker polls 30s, GH run needs ~45s → first click returns nothing, second works.
Root inefficiency: every run reinstalls Chromium+Playwright from scratch.
`actions/cache`, or the never-built prebuilt extractor image, would fix it.

### 5. Housekeeping
- leftover junk KV key `test:key`
- stale key `stream:futbol:fc-espn` from the old wrong key format (should be `stream:tv:`)
- local commits `dc15c21 e21a82e 890c63d 9cba3fa` are **not pushed**; the `ts` fix
  only takes effect once on `main`

---

## Verified commands

```bash
# health
curl -s https://futbol-cuevana-addon.danielmamanidiaz.workers.dev/manifest.json
curl -s https://futbol-cuevana-addon.danielmamanidiaz.workers.dev/catalog/tv/futbol.json      # 100
curl -s https://futbol-cuevana-addon.danielmamanidiaz.workers.dev/stream/tv/fc-espn-nl.json  # 1 stream

# why a dispatch silently does nothing
npx wrangler tail --config workers/addon/wrangler.toml --format pretty
gh run list --workflow=resolve-on-demand.yml --limit 3

# what is actually in KV
python3 -c "import re;print(re.search(r'oauth_token\s*=\s*\"([^\"]+)\"',
  open('/home/daniel/.config/.wrangler/config/default.toml').read()).group(1))"   # then use as bearer
```

Account id `f68c14767025c3954d7adfba7aa76c23`,
KV namespace `c22a04bbc2064e169849f26e41ecc836`.
# Fútbol Libre + Cuevana Stremio Addon

A **Stremio addon** that provides live football matches, movies, and series from Fútbol Libre and Cuevana sources. Built on **Cloudflare Workers + KV** for zero-cost, serverless streaming with **GitHub Actions** for on-demand stream resolution.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Stremio App   │────▶│  Cloudflare Worker│────▶│  Cloudflare KV   │
│  (Client)       │     │  (Addon API)      │     │  (Stream Cache)  │
└─────────────────┘     └────────┬─────────┘     └────────┬─────────┘
                                 │                        │
                    ┌────────────┴────────────┐           │
                    ▼                         ▼           │
            ┌──────────────┐          ┌──────────────┐    │
            │  GitHub      │          │  Daily       │    │
            │  Actions     │          │  Catalog     │    │
            │  (Resolvers) │          │  (Scrapers)  │    │
            └──────┬───────┘          └──────┬───────┘    │
                   │                         │              │
                   ▼                         ▼              │
            ┌──────────────────────────────────────────────┐
            │           Extractors (Python + Playwright)   │
            │  • tvf90.com / fubo18.com (Playwright)       │
            │  • Cuevana hosts via yt-dlp                  │
            └──────────────────────────────────────────────┘
```

### Key Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Addon API** | Cloudflare Worker (TypeScript) | Serves Stremio manifest, catalogs, meta, streams |
| **Stream Cache** | Cloudflare KV | 2-hour TTL for resolved HLS URLs |
| **Catalog Cache** | Cloudflare KV | 24-hour TTL for daily-scraped catalogs |
| **On-Demand Resolver** | GitHub Actions + Python/Playwright | Extracts HLS URLs when users click play |
| **Daily Catalog Scraper** | GitHub Actions (scheduled) | Scrapes Fútbol Libre agenda + Cuevana catalogs |
| **Local Dev** | Docker Compose | Mock KV + Extractors + Worker hot-reload |

### Flow: User Clicks Play

1. Stremio requests `/stream/tv/fc-river-boca.json`
2. Worker checks KV for fresh entry (< 2h)
3. **Cache hit** → returns HLS immediately
4. **Cache miss** → dispatches `resolve-on-demand.yml` workflow
5. Worker polls KV for up to 30s (15×2s)
6. GitHub Action runs extractor, writes to KV
7. Worker returns stream to Stremio

---

## Quick Start (5 Minutes)

### Prerequisites

- **Cloudflare account** (free tier works)
- **GitHub repository** (this repo)
- **TMDB API key** (free at [themoviedb.org](https://www.themoviedb.org/settings/api))
- **GitHub Personal Access Token** with `workflow` scope
- **Node.js 20+** and **Docker** (for local dev)

### 1. Fork & Clone

```bash
git clone https://github.com/YOUR_USERNAME/futbol-cuevana-addon.git
cd futbol-cuevana-addon
```

### 2. Run Setup Script

```bash
chmod +x scripts/setup-secrets.sh
./scripts/setup-secrets.sh
```

The script will:
- ✅ Verify `gh` and `wrangler` CLIs
- ✅ Create Cloudflare KV namespaces (prod + preview)
- ✅ Update `workers/addon/wrangler.toml` with KV IDs
- ✅ Prompt for and set all GitHub secrets

### 3. Deploy Worker

```bash
cd workers/addon
npm install
npx wrangler deploy
```

### 4. Verify Deployment

```bash
# Test manifest
curl https://futbol-cuevana-addon.YOUR_SUBDOMAIN.workers.dev/manifest.json

# Test catalog (will be empty until daily job runs)
curl https://futbol-cuevana-addon.YOUR_SUBDOMAIN.workers.dev/catalog/tv/futbol.json
```

### 5. Add to Stremio

1. Open Stremio → Addons → Community Addons
2. Paste your worker URL: `https://futbol-cuevana-addon.YOUR_SUBDOMAIN.workers.dev/manifest.json`
3. Install → Enjoy Fútbol Libre + Cuevana content!

---

## Deployment Steps (Detailed)

### Required GitHub Secrets

Set these in **Settings → Secrets and variables → Actions**:

| Secret | Description | How to Get |
|--------|-------------|------------|
| `CF_API_TOKEN` | Cloudflare API Token with `Workers KV Storage:Edit` | [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) |
| `CF_ACCOUNT_ID` | Your Cloudflare Account ID | [Cloudflare Dashboard](https://dash.cloudflare.com) → right sidebar |
| `CF_KV_NAMESPACE_ID` | Production KV namespace ID | Created by `setup-secrets.sh` |
| `TMDB_API_KEY` | TMDB API Key (v3) | [TMDB Settings](https://www.themoviedb.org/settings/api) |
| `GH_TOKEN` | GitHub PAT with `workflow` scope | [GitHub Settings → Developer settings](https://github.com/settings/tokens) |

### Create KV Namespaces Manually (Alternative)

```bash
# Production
wrangler kv namespace create "STREAMS_KV"
# → copy the `id` to CF_KV_NAMESPACE_ID secret and wrangler.toml

# Preview (for wrangler dev)
wrangler kv namespace create "STREAMS_KV" --preview
# → copy the `preview_id` to wrangler.toml
```

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `daily-catalog.yml` | Daily 06:00 UTC + manual | Scrapes Fútbol Libre agenda + Cuevana movies/series catalogs |
| `resolve-on-demand.yml` | Manual / Worker dispatch | Resolves single stream URL via extractors |

**Trigger resolver manually:**
```bash
gh workflow run resolve-on-demand.yml \
  -f type=futbol \
  -f id=fc-river-boca \
  -f sourceUrl="https://tvf90.com/1.php?stream=sportv"
```

---

## Local Development

### Prerequisites

- Docker + Docker Compose
- Node.js 20+ (for `wrangler dev` outside Docker)

### Start All Services

```bash
docker-compose -f docker-compose.local.yml up -d --build
```

### Services

| Service | URL | Description |
|---------|-----|-------------|
| **Addon Worker** | http://localhost:8787 | `wrangler dev --local` with mock KV |
| **Mock KV** | http://localhost:8080 | Flask server mimicking Cloudflare KV API |
| **Extractors** | `docker exec -it futbol-extractors bash` | Python environment with Playwright + yt-dlp |

### Test Locally

```bash
# Run integration tests
./scripts/test-local.sh

# Or manually test endpoints
curl http://localhost:8787/manifest.json
curl http://localhost:8787/catalog/tv/futbol.json
curl http://localhost:8080/health
```

### Extractors Shell

```bash
docker-compose -f docker-compose.local.yml exec extractors bash

# Inside container - test extraction
python -m extractors.main --type futbol --id fc-test \
  --url "https://tvf90.com/1.php?stream=sportv" \
  --output /tmp/result.json --no-headless

python -m extractors.main --type cine --id cu-resident-evil \
  --url "https://fembed.net/v/abc123" \
  --output /tmp/result.json
```

### Stop Services

```bash
docker-compose -f docker-compose.local.yml down -v
```

---

## How to Add New Hosts/Sources

### 1. Add a New Futbol Source (Playwright-based)

**File:** `extractors/new_source.py`

```python
"""New futbol source extractor using Playwright."""

import asyncio
from typing import Optional
from pydantic import BaseModel, HttpUrl
from shared.http import StealthBrowser, navigate_with_retry, intercept_hls_requests
from shared.utils import setup_logger, infer_quality_from_url

logger = setup_logger("new_source")


class NewSourceResult(BaseModel):
    hls: HttpUrl
    quality: str = "1080p"
    sourceUrl: HttpUrl


async def extract_new_source_hls(embed_url: str, headless: bool = True) -> NewSourceResult:
    browser = StealthBrowser(headless=headless)
    hls_url: Optional[str] = None

    try:
        await browser.start()
        async with browser.new_page() as page:
            intercepted = await intercept_hls_requests(page, "your-domain.com")
            await navigate_with_retry(page, embed_url)
            # ... custom logic for this source
            if intercepted:
                hls_url = intercepted[0]
            # Fallback extraction logic here
    finally:
        await browser.stop()

    if not hls_url:
        raise RuntimeError(f"Failed to extract HLS from {embed_url}")

    return NewSourceResult(
        hls=hls_url,
        quality=infer_quality_from_url(hls_url),
        sourceUrl=embed_url,
    )
```

**Register in `extractors/main.py`:**
```python
from new_source import extract_new_source_hls, NewSourceResult

# Add to run_extraction():
elif extract_type == "new_source":
    result = await extract_new_source_hls(embed_url, headless)
    return result.model_dump(mode="json")
```

### 2. Add a New Cuevana Host (yt-dlp-based)

Most hosts work automatically via yt-dlp! Just add to `HOST_PRIORITY` in `extractors/cuevana.py`:

```python
HOST_PRIORITY = [
    "fembed",
    "gounlimited",
    "your-new-host",  # Add here (lower = higher priority)
    # ...
]
```

### 3. Add a New Catalog Source

Create `extractors/scrape_new_catalog.py`:

```python
#!/usr/bin/env python3
"""Scrape new source catalog."""

import argparse
import asyncio
import json
import httpx
from bs4 import BeautifulSoup
from shared.utils import setup_logger

logger = setup_logger("scrape_new_catalog")

async def scrape_new_catalog(url: str) -> list:
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
        soup = BeautifulSoup(response.text, "html.parser")
        # ... parse items
        return items

async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    items = await scrape_new_catalog(args.url)
    with open(args.output, "w") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    asyncio.run(main())
```

**Add to `.github/workflows/daily-catalog.yml`:**
```yaml
scrape-new-catalog:
  name: Scrape New Catalog
  runs-on: ubuntu-latest
  container:
    image: ghcr.io/${{ github.repository }}/extractors:latest
  steps:
    - uses: actions/checkout@v4
    - run: pip install -r extractors/requirements.txt
    - run: python -m extractors.scrape_new_catalog --url "https://newsite.com" --output /tmp/new-catalog.json
    - uses: cloudflare/wrangler-action@v3
      with:
        apiToken: ${{ secrets.CF_API_TOKEN }}
        accountId: ${{ secrets.CF_ACCOUNT_ID }}
        command: |
          kv key put --namespace-id=${{ secrets.CF_KV_NAMESPACE_ID }} "catalog:movie:new" --path=/tmp/new-catalog.json
```

**Register catalog in `workers/addon/src/manifest.ts`:**
```typescript
catalogs: [
  // ... existing
  { type: "movie", id: "new", name: "New Source", extra: [{ name: "search", isRequired: false }] },
],
```

---

## Maintenance Guide

### When Things Break

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| **"No streams found"** | Extractor failed / site changed | Check `gh run list --workflow=resolve-on-demand.yml` → view logs |
| **Empty catalogs** | Daily scraper failed | Check `gh run list --workflow=daily-catalog.yml` → re-run manually |
| **Worker 500 errors** | Missing secrets / KV binding | Verify `wrangler secret list` and `wrangler kv namespace list` |
| **Playwright timeouts** | Site anti-bot / layout change | Update selectors in `extractors/tvf90.py` or `scrape_*.py` |
| **yt-dlp fails** | Host changed embed format | `pip install -U yt-dlp` and check extractors |

### Common Fixes

**Update yt-dlp (fixes most Cuevana host issues):**
```bash
# Local
docker-compose exec extractors pip install -U yt-dlp

# CI - just re-run workflow, it installs latest on each run
gh workflow run daily-catalog.yml
```

**Update Playwright browsers:**
```bash
# Local
docker-compose exec extractors playwright install chromium --with-deps

# CI - happens automatically in workflow
```

**Rotate GitHub Token:**
```bash
# Create new PAT at github.com/settings/tokens
gh secret set GH_TOKEN --repo YOUR_REPO --body "$NEW_TOKEN"
```

**Clear Local KV (fresh start):**
```bash
curl -X POST http://localhost:8080/local/clear
```

### Monitoring

```bash
# View worker logs (real-time)
npx wrangler tail

# View GitHub Actions runs
gh run list --limit 20

# Check KV contents (production)
wrangler kv key list --namespace-id=$CF_KV_NAMESPACE_ID
wrangler kv key get "catalog:tv:futbol" --namespace-id=$CF_KV_NAMESPACE_ID
```

### Cost Optimization

- **Cloudflare Workers**: Free tier = 100k requests/day (plenty)
- **KV**: Free tier = 1 GB storage, 1M reads/day
- **GitHub Actions**: Free tier = 2000 min/month (ubuntu-latest)
- **Total cost**: $0/month for typical usage

---

## Troubleshooting

### Worker Returns 404 for All Endpoints

**Cause:** Wrong route pattern or missing `.json` suffix.
**Fix:** Stremio requires `.json` suffix. Test: `curl https://your-worker.workers.dev/manifest.json`

### "KV namespace not found" Error

**Cause:** `wrangler.toml` has placeholder IDs.
**Fix:** Run `./scripts/setup-secrets.sh` or manually create KV namespaces and update `wrangler.toml`.

### GitHub Actions: "Resource not accessible by integration"

**Cause:** `GH_TOKEN` missing `workflow` scope or repo permissions.
**Fix:** Create new PAT with `workflow` scope + repo access.

### Extractor: "Navigation timeout" / "Selector not found"

**Cause:** Source site changed layout or added anti-bot.
**Fix:**
1. Test locally with `--no-headless` to see what's happening
2. Update selectors in `tvf90.py` or `scrape_*.py`
3. Add new wait strategies in `shared/http.py`

### yt-dlp: "Unable to extract" / "No video formats"

**Cause:** Host changed embed player or added DRM.
**Fix:**
```bash
# Test locally with verbose output
docker-compose exec extractors yt-dlp -v "https://host.com/embed/xyz"

# Update yt-dlp
pip install -U yt-dlp
```

### Stremio Shows "No Streams" But KV Has Data

**Cause:** Worker polling timeout (30s) < GitHub Actions execution time.
**Fix:** Check workflow duration in Actions tab. If >30s, increase `POLL_ATTEMPTS` in `workers/addon/src/utils/cache.ts`.

### Catalog Items Missing Poster/Description

**Cause:** Scraper selectors outdated.
**Fix:** Update `parse_match_card()` or `parse_movie_card()` in `scrape_*.py` with new CSS selectors.

### TMDB Meta Not Showing

**Cause:** Missing `TMDB_API_KEY` secret or ID format mismatch.
**Fix:** 
1. Verify secret: `gh secret list --repo YOUR_REPO`
2. IDs must be `fc-<tmdb_id>` or `fc-tt<imdb_id>` format

---

## Project Structure

```
futbol-cuevana-addon/
├── .github/
│   └── workflows/
│       ├── daily-catalog.yml       # Daily catalog scraping
│       └── resolve-on-demand.yml   # On-demand stream resolution
├── workers/
│   └── addon/                      # Cloudflare Worker (TypeScript)
│       ├── src/
│       │   ├── index.ts            # Main entry + routing
│       │   ├── manifest.ts         # Stremio manifest
│       │   ├── routes/
│       │   │   ├── catalog.ts      # Catalog endpoint
│       │   │   ├── meta.ts         # Meta endpoint (TMDB)
│       │   │   └── stream.ts       # Stream endpoint + polling
│       │   ├── clients/
│       │   │   ├── kv.ts           # KV wrapper
│       │   │   ├── github.ts       # GitHub Actions dispatch
│       │   │   └── tmdb.ts         # TMDB client
│       │   └── utils/
│       │       ├── cache.ts        # Keys, TTLs, polling
│       │       └── quality.ts      # Quality normalization
│       ├── wrangler.toml           # Worker config
│       └── package.json
├── extractors/                     # Python extraction logic
│   ├── main.py                     # CLI entry point
│   ├── tvf90.py                    # Fútbol Libre (Playwright)
│   ├── cuevana.py                  # Cuevana hosts (yt-dlp)
│   ├── scrape_futbol_catalog.py    # Daily futbol agenda
│   ├── scrape_cuevana_catalog.py   # Daily movies/series
│   ├── shared/
│   │   ├── http.py                 # Playwright stealth browser
│   │   └── utils.py                # Quality, logging
│   ├── requirements.txt
│   └── Dockerfile
├── scripts/
│   ├── setup-secrets.sh            # One-time setup automation
│   ├── test-local.sh               # Local integration tests
│   └── mock-kv/server.py           # Mock Cloudflare KV API
├── docker-compose.local.yml        # Local dev stack
├── package.json                    # Root workspace config
└── README.md                       # This file
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `./scripts/test-local.sh`
5. Submit a Pull Request

### Code Style

- **TypeScript**: `npm run typecheck` in `workers/addon`
- **Python**: `ruff check extractors/` (if configured)
- **Commits**: Conventional Commits (`feat:`, `fix:`, `chore:`)

---

## Disclaimer

This addon is for educational purposes only. It does not host any content; it only aggregates publicly available links. Users are responsible for complying with applicable copyright laws in their jurisdiction. The authors are not liable for any misuse.
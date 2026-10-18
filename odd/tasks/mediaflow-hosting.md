# MediaFlow hosting — make the addon work off a real device

> Source of truth for this feature. Engram mirror: topic `odd/mediaflow-hosting/tasks`.

**Objective:** MediaFlow Proxy runs on a public host so the addon resolves
Cuevana from any Stremio client, not just from a laptop running `wrangler dev`.

**Problem:** The Cuevana path is verified working end-to-end locally, but the
Worker runs on Cloudflare's edge and can reach neither `127.0.0.1` nor the LAN.
The addon is deployed nowhere and MediaFlow is hosted nowhere, so the feature
exists only on one machine. `MEDIAFLOW_BASE` was also undocumented: a deploy
without it returns `[]` for every Cuevana request and surfaces no error. The
README did not mention MediaFlow at all, and its manual-trigger example used an
input name (`type`) that the workflow does not accept.

**Why:** User decision 2026-10-18 — host MediaFlow publicly (~USD 5/month)
instead of a Cloudflare tunnel, so the addon does not depend on a home PC being
awake and does not push all video through a home upload link.

**Scope:** MediaFlow's deployment config, the Worker's secret/vars wiring, and
documentation of the `MEDIAFLOW_BASE` requirement. Not in scope: the Cuevana
resolution logic itself (shipped in `b24e855`) and the football extractors.

**Constraints:**
- No deploys and no remote operations without explicit user OK. Remote work
  needs its own authorization: destination, operation, and credential.
- No Docker in the dev environment, so deploy the published upstream image
  rather than building from source.
- Pin the image tag; `latest` is not a version.

## Tasks

- [ ] **H1 — Deployment config.** Files: `deploy/mediaflow/fly.toml`,
  `deploy/mediaflow/README.md`. Deploy the pinned upstream image and set the env
  vars that are actually required behind a reverse proxy.
  Accept: the files exist, parse, and the README carries a procedure that can be
  followed without reading the upstream repo.
- [ ] **H2 — Document the `MEDIAFLOW_BASE` requirement.** Files: `README.md`.
  Accept: a fresh deploy following the README cannot silently lose Cuevana.
- [ ] **H3 — Local dev parity.** Files: `docker-compose.local.yml`. Add MediaFlow
  so local dev matches production.
- [ ] **H4 — Worker secret wiring.** `MEDIAFLOW_API_PASSWORD` is not among the
  secrets `scripts/setup-secrets.sh` pushes, and it is a Worker secret, not a
  GitHub one. Document the wiring (H2) and only change the script if the manual
  path proves error-prone.
- [ ] **H5 — Deploy and verify from a third-party client.** Requires H1+H4 and
  explicit authorization for the remote operations.
  Accept: `{worker}/stream/movie/cu-<real-slug>.json` returns streams from a
  device that is not this machine. Unverified until then.

## Evidence

- **MediaFlow needs no Playwright/Chromium.** Zero matches in its
  `pyproject.toml`; the image's runtime stage installs only `ffmpeg`, `libffi8`,
  `libxml2`, `libxslt1.1`. The smallest Fly machine class is therefore viable.
- **Upstream publishes multi-arch images to Docker Hub.** 60 tags; newest is
  `v2.4.9` (2026-05-19) with `amd64` + `arm64`. The `Dockerfile` is multi-stage
  and needs Rust in the builder, so using the published image also avoids a slow
  local build that this environment cannot run anyway.
- **`FORWARDED_ALLOW_IPS` must be set behind a reverse proxy.** Upstream's own
  `docker-compose.yml` sets `FORWARDED_ALLOW_IPS: "*"`, its uvicorn docs say to
  pass `--forwarded-allow-ips "*"` whenever the server is not local, and the
  image's `CMD` defaults it to `127.0.0.1`.
- **`API_PASSWORD` is not optional for a public host.** It is the only thing
  preventing a stranger from using the deployment as an open proxy and spending
  the operators's bandwidth.
- **`GUNICORN_WORKERS` and Redis are coupled.** `REDIS_URL` defaults to disabled,
  and Redis is what shares the extractor/segment/HEAD caches across workers.
  Without it, extra workers duplicate extraction work instead of sharing it.
- **Fly.io cost (verified 2026-10-18, `fly.io/docs/about/pricing/`):** no free
  tier for new organizations; `shared-cpu-1x`/256MB is $2.19 per 30 days,
  `shared-cpu-1x`/1GB is $6.70, egress $0.02/GB in North America and Europe.
  MediaFlow proxies HLS segments, so video egress is a real line item, not a
  rounding error.

## Status

H1–H3 done and committed. H5 requires the user's remote authorization. Hosting
target chosen: Fly.io.

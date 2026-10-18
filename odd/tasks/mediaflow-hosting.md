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

- [x] **H1 — Deployment config.** Files: `deploy/mediaflow/docker-compose.yml`,
  `deploy/mediaflow/Caddyfile`, `deploy/mediaflow/.env.example`,
  `deploy/mediaflow/README.md`. Deploy the pinned upstream image and set the env
  vars that are actually required behind a reverse proxy.
  Accept: the files exist, parse, and the README carries a procedure that can be
  followed without reading the upstream repo.
- [x] **H2 — Document the `MEDIAFLOW_BASE` requirement.** Files: `README.md`.
  Accept: a fresh deploy following the README cannot silently lose Cuevana.
- [x] **H3 — Local dev parity.** Files: `docker-compose.local.yml`. Add MediaFlow
  so local dev matches production.
- [x] **H4 — Worker secret wiring.** `MEDIAFLOW_API_PASSWORD` is not among the
  secrets `scripts/setup-secrets.sh` pushes, and it is a Worker secret, not a
  GitHub one. Resolved by documenting the manual path (H2); the script was left
  unchanged, which is the documented decision.
- [ ] **H5 — Deploy and verify from a third-party client.** Requires H1+H4 and
  explicit authorization for the remote operations.
  Accept: `{worker}/stream/movie/cu-<real-slug>.json` returns streams from a
  device that is not this machine. Unverified until then.

## Evidence

- **MediaFlow needs no Playwright/Chromium.** Zero matches in its
  `pyproject.toml`; the image's runtime stage installs only `ffmpeg`, `libffi8`,
  `libxml2`, `libxslt1.1`. Small machine classes are therefore viable.
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
  the operator's bandwidth.
- **`GUNICORN_WORKERS` and Redis are coupled.** `REDIS_URL` defaults to disabled,
  and Redis is what shares the extractor/segment/HEAD caches across workers.
  Without it, extra workers duplicate extraction work instead of sharing it.
- **`ENABLE_HLS_PREBUFFER` defaults to true** and can claim a large share of
  system memory for its segment cache, which is why swap is a setup step rather
  than a nicety on a 1 GB droplet.
- **Fly.io cost (verified 2026-10-18, `fly.io/docs/about/pricing/`):** no free
  tier for new organizations; `shared-cpu-1x`/256MB is $2.19 per 30 days,
  `shared-cpu-1x`/1GB is $6.70, egress $0.02/GB in North America and Europe.
  MediaFlow proxies HLS segments, so video egress is a real line item.
- **DigitalOcean cost (verified 2026-10-18, `digitalocean.com/pricing/droplets`):**
  `s-1vcpu-1gb` is $6.00/month and **includes 1,000 GiB of outbound transfer**
  ($12.00/month gives 2,000 GiB); inbound is free. Billing is per-second with a
  60-second minimum and Bundled Plans are capped at the monthly price, so a
  create-and-destroy smoke test costs cents rather than a month. At ~1.1 GB/hour
  of 720p, 1 TB is roughly 900 hours of viewing — which is why transfer
  included-in-plan beats metered egress for this workload.
- **sslip.io works for certificate issuance without owning a domain.** Verified
  2026-10-18: both `203.0.113.10.sslip.io` and the `.nip.io` equivalent resolve
  to the embedded IP, so Caddy can complete an ACME HTTP-01 challenge against it.

## Decision log

- **2026-10-18 — hosting target moved from Fly.io to DigitalOcean.** Fly was
  chosen first and priced; DigitalOcean displaced it on transfer economics. The
  deciding number is the included outbound transfer (1 TB at $6/mo) against Fly's
  metered $0.02/GB with no free tier, because MediaFlow's own segment proxying
  makes egress the bill. Cost of the change: `fly.toml` was removed rather than
  left as dead config, and TLS moved from Fly's automatic certificates to Caddy
  with a Let's Encrypt certificate. The tradeoff accepted: an unmanaged host means
  OS updates, firewall rules and certificate renewal are now ours.

## Status

H1–H4 done and committed on `feat/extractor-fanout`. Hosting target: **DigitalOcean**
(superseding the earlier Fly.io choice; see the decision log).

**H5 is blocked on user-supplied access, not on work.** To proceed, the droplet
must exist and be reachable:

1. A Droplet with `~/.ssh/navbr_mediaflow.pub` installed as an authorized key.
2. The droplet's public IP supplied to the agent.

Nothing else is needed to start: the deploy key exists, `ssh`/`scp`/`rsync` are
present in the dev environment, the uppercase-less `sshpass` is absent so key
auth is the only workable route, and `doctl` is not installed — the droplet is
created by hand in the panel so the billing decision stays with the user.

**Open risk carried into H5:** the local end-to-end test ran from a residential
IP. A datacenter IP may be refused by the CDN where a residential one is served,
which is the same failure class `handleVideoProxy` and `rewriteToProxy` already
work around for four football CDNs. Untestable until the droplet exists; test it
as the first action after bring-up while the per-second billing keeps the cost
negligible.

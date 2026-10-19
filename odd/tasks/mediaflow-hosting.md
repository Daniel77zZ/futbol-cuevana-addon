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
- **The datacenter-IP question is answered: YES, it works.** Verified 2026-10-18
  from a GitHub-hosted runner — itself a datacenter IP, egress `20.109.38.241`
  (Azure) — running the real extractor and the real MediaFlow client. The Cuevana
  page fetched, both `?token=` servers were found, the embed decoded to the same
  host a residential IP gets, and **both** hosts returned an `#EXTM3U` master
  playlist and real segment bytes (StreamHG 7,204 B, StreamWish 323,708 B). The
  domain is Cloudflare-fronted but the datacenter range was **not** refused.
  Reproduce with the `probe-datacenter` workflow; note `workflow_dispatch` cannot
  start it until that file reaches `main`, so on a branch it runs via its own
  push trigger.
- **Egress really does flow through the host — measured, not assumed.** Both
  hosts answered `proxied_through_mediaflow=true`: the playlist 302s to
  `/proxy/hls/manifest.m3u8`, and the manifest's first segment resolved back to
  the MediaFlow instance rather than to the CDN. The ~1.1 GB/h figure is
  therefore the **operator's** bill, which is what the whole cost comparison
  rested on, and it means included-transfer-in-plan beats metered egress.
- **The video CDN behind StreamHG is `acek-cdn.com`.** StreamHG's manifest
  registered 476 media segments with HLS prebuffering active
  (`prefetch_limit=5`), so `ENABLE_HLS_PREBUFFER` is on by default in practice
  and the memory guidance for a 1 GB box stands.

## Decision log

- **2026-10-18 — hosting target moved from Fly.io to DigitalOcean.** Fly was
  chosen first and priced; DigitalOcean displaced it on transfer economics. The
  deciding number is the included outbound transfer (1 TB at $6/mo) against Fly's
  metered $0.02/GB with no free tier, because MediaFlow's own segment proxying
  makes egress the bill. Cost of the change: `fly.toml` was removed rather than
  left as dead config, and TLS moved from Fly's automatic certificates to Caddy
  with a Let's Encrypt certificate. The tradeoff accepted: an unmanaged host means
  OS updates, firewall rules and certificate renewal are now ours.
- **2026-10-18 — DigitalOcean rejected by the user; hosting target returned to
  undecided.** A $24 minimum was seen at checkout, which contradicts the verified
  panel prices ($4 / $6 / $12) and was not argued against: the user's screen is
  the authority on what they are willing to pay. Oracle Cloud Always Free was
  raised as the free alternative and rejected on account-validation grounds
  ("su validacion ya intente un monton"), consistent with its documented
  requirement for a real card. Consequence: the deploy artifacts stay
  provider-agnostic, and the README's provider section is the only part that must
  change when a host is finally chosen.
- **2026-10-18 — the datacenter-IP risk was retired for $0 before renting
  anything.** Renting first would have meant paying to answer a question a
  GitHub-hosted runner answers for free, since the runner is itself a datacenter
  IP with Docker available. The sequencing is the reusable part: the unknown that
  could have invalidated every candidate host was retired before any money moved,
  and it came back PASS.

## Status

H1–H4 done and committed on `feat/extractor-fanout`. **Hosting target:
undecided.** Fly.io was priced and dropped on egress economics; DigitalOcean was
chosen and then rejected by the user (a $24 minimum at checkout, which does not
match the verified $4/$6/$12 panel prices); Oracle Cloud Always Free was rejected
on account-validation grounds. See the decision log.

**The risk that justified renting a server first is now closed.** The
datacenter-IP question was the one thing that could invalidate any host, and it is
answered YES — for free, from a GitHub-hosted runner (see Evidence). Host choice
is therefore a pure cost question rather than a gamble, and the cost axis is
confirmed to be egress, because segments were measured to proxy through MediaFlow.

**H5 is blocked on user-supplied access, not on work.** To proceed, any host with
Docker must exist and be reachable:

1. A VPS with `~/.ssh/navbr_mediaflow.pub` installed as an authorized key.
2. That host's public IP supplied to the agent.

Nothing else is needed to start: the deploy key exists, `ssh`/`scp`/`rsync` are
present in the dev environment, `sshpass` is absent so key auth is the only
workable route, and `doctl` is not installed — the host is created by hand in a
panel so the billing decision stays with the user. The deploy stack
(`docker-compose.yml` + `Caddyfile` + `<IP>.sslip.io`) is provider-agnostic, so
switching provider costs nothing beyond the README's provider section.

**Remaining carried risk:** the probe exercised a single movie. The football path
has still never been tested against MediaFlow.

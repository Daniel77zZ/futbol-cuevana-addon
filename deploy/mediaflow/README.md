# MediaFlow Proxy deployment — DigitalOcean

MediaFlow Proxy is the extraction and playback engine for the **Cuevana** path
(movies and series). It scrapes the page, extracts the embed, rewrites the HLS
manifest and proxies the segments.

It is **required**: without a reachable MediaFlow, the Worker returns an empty
stream list for every Cuevana movie and series. It will not error — it returns
`[]` and logs `cuevana_unresolved`. Football does **not** use MediaFlow; it still
goes through the Python extractors and the GitHub Actions workflow.

Upstream project: <https://github.com/mhdzumair/mediaflow-proxy>

Deployed as two containers on one droplet: `mediaflow` (never published) behind
`caddy` (publishes 80/443 and terminates TLS).

---

## Why it has to be public

The Worker runs on Cloudflare's edge. It can reach neither `127.0.0.1` nor your
LAN, so MediaFlow cannot live on your laptop. Any host with a public HTTPS
endpoint works; this directory targets DigitalOcean.

## What to create

One Droplet, from the DigitalOcean control panel (**Create → Droplets**):

| Setting | Value |
| --- | --- |
| Region | New York (nyc3) or Atlanta (atl1) — closest to Argentina |
| Image | Ubuntu 24.04 LTS, **or** the *Docker* Marketplace 1-Click image to skip the Docker install |
| Size | Basic / Regular / **$6/mo** — 1 GB RAM, 1 vCPU, 25 GB SSD, 1 TB transfer |
| Authentication | **SSH Key** → *New SSH Key* → paste the deploy key |
| Hostname | `mediaflow` |

**Add the SSH key.** Without it there is no way in. The key for this deployment
is `~/.ssh/navbr_mediaflow`; the public half is what goes in the panel.

If the droplet starts thrashing during playback, resize it to 2 GB / $12/mo —
DigitalOcean resizes an existing droplet, so nothing has to be recreated.

## Setup on the droplet

```bash
# Firewall: only SSH, HTTP (ACME challenge) and HTTPS.
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Swap guard. MediaFlow's HLS pre-buffer is on by default and can claim a large
# share of RAM; without swap on a 1 GB droplet the OOM killer takes the container.
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Only if the image is plain Ubuntu rather than the Docker 1-Click image.
curl -fsSL https://get.docker.com | sh
```

## Deploy

```bash
# From this repository, copy the stack up (no clone or repo credentials needed).
scp -r deploy/mediaflow root@<DROPLET_IP>:/opt/mediaflow

# On the droplet: create the env file, generate the password, set the hostname.
ssh root@<DROPLET_IP>
cd /opt/mediaflow
cp .env.example .env
openssl rand -hex 24          # paste into API_PASSWORD
nano .env                     # API_PASSWORD + MEDIAFLOW_DOMAIN
docker compose up -d
docker compose logs -f caddy  # wait for the certificate to be issued
```

`MEDIAFLOW_DOMAIN` with no domain of your own: use the droplet IP in sslip.io
form, e.g. `203.0.113.10.sslip.io`. sslip.io resolves any such name back to the
IP embedded in it, so Caddy can obtain a real Let's Encrypt certificate without
you buying or configuring a domain. With a domain you control, point an A record
at the droplet and use that name instead — only this one variable changes.

## Point the Worker at it

Two different mechanisms, and mixing them up is the usual mistake:

```bash
# MEDIAFLOW_BASE is a plain var in workers/addon/wrangler.toml -> [vars]
#   MEDIAFLOW_BASE = "https://203.0.113.10.sslip.io"

# MEDIAFLOW_API_PASSWORD is a secret, never a var
cd workers/addon
npx wrangler secret put MEDIAFLOW_API_PASSWORD   # paste the SAME value as API_PASSWORD
npx wrangler deploy
```

Then confirm a real title resolves:

```bash
curl -s "https://<your-worker>/stream/movie/cu-<real-slug>.json" | head -c 400
```

An empty `streams` array with `cuevana_unresolved` in the logs means the Worker
cannot reach MediaFlow or the password does not match. Check `MEDIAFLOW_BASE`
first — a missing or placeholder value is the most common cause.

## Notes that cost time if you skip them

- **Never leave `API_PASSWORD` unset on a public host.** It is the only thing
  stopping a stranger from using the deployment as an open proxy and spending
  your bandwidth. The compose file refuses to start when it is missing.
- **The container's `CMD` defaults `FORWARDED_ALLOW_IPS` to `127.0.0.1`**, which
  is wrong behind Caddy. `docker-compose.yml` sets it to `*`; upstream's own
  compose file does the same.
- **`GUNICORN_WORKERS` above 1 without Redis buys nothing.** Redis is what shares
  the extractor and segment caches between workers; without it, extra workers
  repeat each other's extraction.
- **Port 80 must stay reachable.** Caddy answers the ACME challenge there. Close
  it and certificate renewal fails silently until the certificate expires.
- **Version pinning is deliberate.** The image tag is pinned because `latest`
  moves. Upstream publishes `amd64` and `arm64`, so the architecture is not a
  constraint.
- **Delete the `caddy_data` volume and you re-request certificates**, which can
  hit Let's Encrypt rate limits.

## Cost reality

Verified 2026-10-18 against `digitalocean.com/pricing/droplets`. Basic Droplets,
Regular CPU:

| Size | Memory | Transfer | SSD | Price |
| --- | --- | --- | --- | --- |
| `s-1vcpu-512mb-10gb` | 512 MiB | 500 GiB | 10 GiB | $4.00 / mo |
| `s-1vcpu-1gb` | 1 GiB | **1,000 GiB** | 25 GiB | **$6.00 / mo** |
| `s-1vcpu-2gb` | 2 GiB | **2,000 GiB** | 50 GiB | $12.00 / mo |

Billing is per-second with a 60-second minimum, and Bundled Plans are capped at
the monthly price — so a droplet created and destroyed within the hour costs
cents, not a month. That makes the first smoke test cheap.

**Transfer is the deciding number.** MediaFlow proxies the video segments, so
every hour watched is bandwidth through this machine — on the order of 1.1 GB
per hour at 720p. At 1 GB/h, the 1 TB included with the $6 plan is roughly **900
hours of viewing per month**; inbound is always free. That is the reason this
target beats Fly.io, which has no free tier and bills egress at $0.02/GB.
Set a billing alert in the DigitalOcean panel anyway.

## The one thing that cannot be verified from here

The local end-to-end test ran from a **residential** IP. This droplet is a
**datacenter** IP, and some CDNs serve residential clients while blocking
datacenter ranges. This repository already carries evidence that the pattern is
real in this domain: `handleVideoProxy` and `rewriteToProxy` in
`workers/addon/src/routes/stream.ts` exist because four football CDNs reject
datacenter IPs.

Whether Cuevana's CDN does the same is **unknown and untestable from here**. Test
it immediately after bring-up, before trusting the deployment:

```bash
# From the droplet: can it fetch the embed and the manifest at all?
docker compose exec mediaflow sh -c \
  'curl -s -o /dev/null -w "%{http_code}\n" "https://tungtungsahur.cuevana3r.pro/"'
```

If a residential IP works and this one does not, the fallback is the same
mechanism the football path already uses: route through the Worker proxy rather
than letting the client fetch the CDN directly.

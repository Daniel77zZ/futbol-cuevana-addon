# MediaFlow Proxy deployment

MediaFlow Proxy is the extraction and playback engine for the **Cuevana** path
(movies and series). It scrapes the page, extracts the embed, rewrites the HLS
manifest and proxies the segments.

It is **required**: without a reachable MediaFlow, the Worker returns an empty
stream list for every Cuevana movie and series. It will not error — it returns
`[]` and logs `cuevana_unresolved`. Football does **not** use MediaFlow; it still
goes through the Python extractors and the GitHub Actions workflow.

Upstream project: <https://github.com/mhdzumair/mediaflow-proxy>

---

## Why it has to be public

The Worker runs on Cloudflare's edge. It can reach neither `127.0.0.1` nor your
LAN, so MediaFlow cannot live on your laptop. It is deployed here to Fly.io;
any host with a public HTTPS endpoint works.

## Deploy

```bash
# 1. Install and log in
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Create the app. The name in fly.toml must be globally unique.
fly apps create futbol-mediaflow

# 3. Set the password BEFORE the first deploy, so the deployment is never
#    briefly open to the internet.
fly secrets set API_PASSWORD="$(openssl rand -hex 24)" --app futbol-mediaflow

# 4. Save that same value: the Worker needs it (see below).

# 5. Deploy
fly deploy --app futbol-mediaflow
fly status --app futbol-mediaflow
```

## Point the Worker at it

Two different mechanisms, and mixing them up is the usual mistake:

```bash
# MEDIAFLOW_BASE is a plain var in workers/addon/wrangler.toml -> [vars]
#   MEDIAFLOW_BASE = "https://futbol-mediaflow.fly.dev"

# MEDIAFLOW_API_PASSWORD is a secret, never a var
cd workers/addon
npx wrangler secret put MEDIAFLOW_API_PASSWORD   # paste the same value
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
  your bandwidth.
- **The container's `CMD` defaults `FORWARDED_ALLOW_IPS` to `127.0.0.1`**, which
  is wrong behind a reverse proxy. `fly.toml` sets it to `*`; upstream's own
  compose file does the same.
- **`GUNICORN_WORKERS` above 1 without Redis buys nothing.** Redis is what shares
  the extractor and segment caches between workers; without it, extra workers
  repeat each other's extraction.
- **The app name must be globally unique.** `fly apps create` fails on a taken
  name; change it in `fly.toml` too.
- **Version pinning is deliberate.** The image tag is pinned because `latest`
  moves. Upstream publishes `amd64` and `arm64`, so the architecture is not a
  constraint.

## Cost reality

Fly.io has no free tier. Verified 2026-10-18 against `fly.io/docs/about/pricing/`:

| Item | Price |
| --- | --- |
| `shared-cpu-1x` / 256MB, always on | $2.19 / 30 days |
| `shared-cpu-1x` / 1GB, always on | $6.70 / 30 days |
| Egress to the internet, North America & Europe | $0.02 / GB |

With `auto_stop_machines = "suspend"` the compute cost drops with idle time, but
**egress is the variable to watch**: MediaFlow proxies the video segments, so
every hour watched is bandwidth through this machine — roughly 1.1 GB per hour
at 720p. A handful of hours a week is small change; heavy viewing is a real bill.
Pin a budget alert in the Fly dashboard.

If egress is the deciding factor, a plain VPS usually includes a much larger
monthly traffic allowance for a similar price. That tradeoff was not priced out
here — say the word and it can be.

import type { Stream as SdkStream } from "stremio-addon-sdk";
import type { Env } from "../index";
import { triggerResolveWorkflow } from "../clients/github";
import { KvClient, type StreamCache } from "../clients/kv";
import { POLL_ATTEMPTS, POLL_INTERVAL_MS, isFresh, logInfo, sleep } from "../utils/cache";
import { normalizeQuality, sortByQuality } from "../utils/quality";

/**
 * Stremio `Stream`, extended with the `quality` field requested by this addon's
 * KV/response contract. Stremio renders `title`, so we populate both: `title`
 * (spec-compliant display) and `quality` (convenience/metadata).
 */
export interface Stream extends SdkStream {
  url: string;
  name: string;
  quality: string;
}

/** Known content sources, keyed by the Stremio id prefix. */
const SOURCES: Record<string, { label: string; base: string }> = {
  fc: { label: "Fútbol Libre", base: "https://www.futbollibre.tv" },
  cu: { label: "Cuevana", base: "https://cuevana3.ch" },
};

/**
 * Resolves playable streams for `type` + `id`.
 *
 * 1. Fresh KV hit (< 2h) -> return immediately.
 * 2. Cache miss/stale -> dispatch the GitHub Actions resolver.
 * 3. Poll KV for up to 30s (15 × 2s) for the resolver's write.
 * 4. Timeout -> empty list (Stremio shows "no streams").
 */
export async function resolveStreams(env: Env, type: string, id: string): Promise<Stream[]> {
  const kv = KvClient.fromEnv(env);

  const cached = await kv.getStream(type, id);
  if (cached && isFresh(cached.ts) && cached.hls) {
    return sortByQuality([toStream(id, cached)]);
  }

  // Reuse the source URL recorded by a previous resolution when possible.
  const sourceUrl = cached?.sourceUrl || buildSourceUrl(id);
  await triggerResolveWorkflow(env, { type, id, sourceUrl });

  const resolved = await pollForStream(kv, type, id);
  if (!resolved) {
    logInfo("stream_resolve_timeout", { type, id });
    return [];
  }

  return sortByQuality([toStream(id, resolved)]);
}

async function pollForStream(kv: KvClient, type: string, id: string): Promise<StreamCache | null> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    const entry = await kv.getStream(type, id);
    if (entry && isFresh(entry.ts) && entry.hls) return entry;
  }
  return null;
}

function toStream(id: string, cache: StreamCache): Stream {
  const quality = normalizeQuality(cache.quality);
  return {
    url: cache.hls,
    name: sourceLabel(id),
    title: quality,
    quality,
  };
}

/** Maps a prefixed id (`fc-...`, `cu-...`) to a human-readable source name. */
export function sourceLabel(id: string): string {
  const prefix = id.slice(0, 2);
  return SOURCES[prefix]?.label ?? "Fútbol Cuevana";
}

/**
 * Best-effort reconstruction of the page the resolver should scrape.
 * The id suffix is treated as a URL path under the source's base domain.
 */
export function buildSourceUrl(id: string): string {
  const dash = id.indexOf("-");
  const prefix = dash === -1 ? id : id.slice(0, dash);
  const slug = dash === -1 ? "" : id.slice(dash + 1);

  const source = SOURCES[prefix];
  if (!source || slug.length === 0) return id;

  return `${source.base}/${slug.replace(/^\/+/, "")}`;
}

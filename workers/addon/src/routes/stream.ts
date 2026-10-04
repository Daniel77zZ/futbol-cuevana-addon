import type { Stream as SdkStream } from "stremio-addon-sdk";
import type { Env } from "../index";
import { triggerResolveWorkflow } from "../clients/github";
import { KvClient, type StreamCache } from "../clients/kv";
import { POLL_ATTEMPTS, POLL_INTERVAL_MS, isFresh, logInfo, sleep } from "../utils/cache";
import { normalizeQuality, sortByQuality } from "../utils/quality";

export interface Stream extends SdkStream {
  url: string;
  name: string;
  quality: string;
}

const SOURCES: Record<string, { label: string; base: string }> = {
  fc: { label: "Fútbol Libre", base: "https://www.futbollibre.tv" },
  cu: { label: "Cuevana", base: "https://cuevana3.ch" },
};

export async function resolveStreams(env: Env, type: string, id: string): Promise<Stream[]> {
  const kv = KvClient.fromEnv(env);

  const cached = await kv.getStream(type, id);
  if (cached && isFresh(cached.ts) && cached.hls) {
    return sortByQuality([toStream(id, cached)]);
  }

  const sourceUrl = await getEmbedUrlFromCatalog(kv, type, id);
  console.log("DEBUG: resolveStreams", { type, id, sourceUrl });
  await triggerResolveWorkflow(env, { type, id, sourceUrl });

  const resolved = await pollForStream(kv, type, id);
  if (!resolved) {
    logInfo("stream_resolve_timeout", { type, id });
    return [];
  }

  return sortByQuality([toStream(id, resolved)]);
}

async function getEmbedUrlFromCatalog(kv: KvClient, type: string, id: string): Promise<string> {
  try {
    const prefix = id.split("-")[0];
    const catalogType = prefix === "fc" ? "futbol" : type === "movie" ? "cine" : "series";
    const catalogKey = `catalog:${type}:${catalogType}`;
    console.log("DEBUG: getEmbedUrlFromCatalog", { type, id, catalogKey });
    const items = await kv.getJson<CatalogItem[]>(`catalog:${type}:${catalogType}`);
    console.log("DEBUG: items", { items: items ? items.length : 0 });
    if (items && Array.isArray(items)) {
      const item = items.find(i => i.id === id);
      console.log("DEBUG: found item", { item: item ? { id: item.id, embedUrl: item.embedUrl } : null });
      if (item && item.embedUrl) {
        return item.embedUrl;
      }
    }
  } catch (err) {
    console.warn("Failed to get embedUrl from catalog:", err);
  }
  return buildSourceUrl(id);
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

export function sourceLabel(id: string): string {
  const prefix = id.slice(0, 2);
  return SOURCES[prefix]?.label ?? "Fútbol Cuevana";
}

export function buildSourceUrl(id: string): string {
  const dash = id.indexOf("-");
  const prefix = dash === -1 ? id : id.slice(0, dash);
  const slug = dash === -1 ? "" : id.slice(dash + 1);

  const source = SOURCES[prefix];
  if (!source || slug.length === 0) return id;

  return `${source.base}/${slug.replace(/^\/+/, "")}`;
}

interface CatalogItem {
  id: string;
  name: string;
  type: "movie" | "series" | "tv";
  poster: string;
  description?: string;
  embedUrl?: string;
}

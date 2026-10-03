import type { Env } from "../index";
import {
  CATALOG_TTL_SECONDS,
  STREAM_TTL_SECONDS,
  catalogKey,
  logError,
  streamKey,
} from "../utils/cache";

/** Shape written by the GitHub Actions resolver under `stream:${type}:${id}`. */
export interface StreamCache {
  /** Direct HLS/HTTP URL to play. */
  hls: string;
  /** Raw quality as reported by the source (normalized on read). */
  quality: string;
  /** Page the resolver scraped, kept for debugging/refresh. */
  sourceUrl: string;
  /** Unix epoch milliseconds when the entry was written. */
  ts: number;
}

/** Shape written by `daily-catalog.yml` under `catalog:${type}:${id}`. */
export interface CatalogItem {
  id: string;
  name: string;
  type: "movie" | "series" | "tv";
  poster: string;
  description?: string;
}

/**
 * Thin, typed wrapper around the Cloudflare KV binding.
 *
 * KV reads/writes are best-effort: a storage failure must degrade to a cache
 * miss rather than a 500, so both directions swallow and log errors.
 */
export class KvClient {
  constructor(private readonly kv: KVNamespace) {}

  static fromEnv(env: Env): KvClient {
    return new KvClient(env.STREAMS_KV);
  }

  async getStream(type: string, id: string): Promise<StreamCache | null> {
    return this.getJson<StreamCache>(streamKey(type, id));
  }

  async putStream(
    type: string,
    id: string,
    data: StreamCache,
    ttlSeconds: number = STREAM_TTL_SECONDS,
  ): Promise<void> {
    await this.putJson(streamKey(type, id), data, ttlSeconds);
  }

  async getCatalog(type: string, id: string): Promise<CatalogItem[] | null> {
    return this.getJson<CatalogItem[]>(catalogKey(type, id));
  }

  async putCatalog(
    type: string,
    id: string,
    items: CatalogItem[],
    ttlSeconds: number = CATALOG_TTL_SECONDS,
  ): Promise<void> {
    await this.putJson(catalogKey(type, id), items, ttlSeconds);
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const value = await this.kv.get<T>(key, "json");
      return value ?? null;
    } catch (err) {
      logError("kv_get_failed", { key, error: String(err) });
      return null;
    }
  }

  async putJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      // KV requires expirationTtl >= 60 seconds.
      await this.kv.put(key, JSON.stringify(value), {
        expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
      });
    } catch (err) {
      logError("kv_put_failed", { key, error: String(err) });
    }
  }
}

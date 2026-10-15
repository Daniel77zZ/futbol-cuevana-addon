import type { Env } from "../index";
import { KvClient } from "../clients/kv";
import { resolveFirstVidHideV2 } from "../extractors/vidhide_v2";

export async function debugCatalog(env: Env, type: string, id: string) {
  const kv = KvClient.fromEnv(env);
  
  const items = await kv.getJson<any[]>(`catalog:tv:futbol`);
  
  return {
    catalogKey: `catalog:tv:futbol`,
    itemCount: items?.length || 0,
    firstItem: items?.[0] || null,
    hasEmbedUrl: items?.[0]?.embedUrl || null,
  };
}

export async function debugStream(env: Env, type: string, id: string) {
  const kv = KvClient.fromEnv(env);
  const stream = await kv.getStream(type, id);
  return { stream };
}

export async function debugVidHideV2(env: Env, type: string, tmdbId: string) {
  try {
    const { resolveVidHideV2 } = await import("../extractors/vidhide_v2");
    const result = await resolveVidHideV2(type as "tv" | "movie", tmdbId);
    return { success: true, streams: result.streams, source: result.source };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function debugCandidates(env: Env, type: string, id: string) {
  const kv = KvClient.fromEnv(env);
  const key = `stream:candidates:${type}:${id}`;
  const candidates = await kv.getJson<any[]>(key);
  return { key, candidates: candidates ?? [], count: candidates?.length ?? 0 };
}

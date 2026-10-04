import type { Env } from "../index";
import { KvClient } from "../clients/kv";

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

import type { MetaPreview } from "stremio-addon-sdk";
import type { Env } from "../index";
import { KvClient, type CatalogItem } from "../clients/kv";
import { logInfo } from "../utils/cache";

/**
 * Reads a pre-built catalog from KV (`catalog:${type}:${id}`), populated by the
 * `daily-catalog.yml` workflow. Supports the optional Stremio `search` and
 * `skip` extras.
 */
export async function getCatalog(
  env: Env,
  type: string,
  id: string,
  extra: Record<string, string> = {},
): Promise<MetaPreview[]> {
  const kv = KvClient.fromEnv(env);
  const items = await kv.getCatalog(type, id);
  if (!items || items.length === 0) {
    logInfo("catalog_empty", { type, id });
    return [];
  }

  let result = items;

  const search = extra["search"]?.trim().toLowerCase();
  if (search) {
    result = result.filter((item) => item.name.toLowerCase().includes(search));
  }

  const skip = Number.parseInt(extra["skip"] ?? "", 10);
  if (Number.isFinite(skip) && skip > 0) {
    result = result.slice(skip);
  }

  return result.map(toMetaPreview);
}

function toMetaPreview(item: CatalogItem): MetaPreview {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster,
    description: item.description,
  };
}

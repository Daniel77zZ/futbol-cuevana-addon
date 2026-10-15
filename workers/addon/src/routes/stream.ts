import type { Stream as SdkStream } from "stremio-addon-sdk";
import type { Env } from "../index";
import { triggerResolveWorkflow } from "../clients/github";
import { KvClient, type StreamCache } from "../clients/kv";
import { DecryptorClient, decryptorServersToStreams, type DecryptorServer } from "../clients/decryptor";
import { TmdbClient, type TmdbRef } from "../clients/tmdb";
import { CuevanaExtractor, type CuevanaStream } from "../extractors/cuevana";
import { POLL_ATTEMPTS, POLL_INTERVAL_MS, isFresh, logInfo, sleep } from "../utils/cache";
import { normalizeQuality, sortByQuality, fetchTrueQuality, qualityFromHeight, qualityRank } from "../utils/quality";
import { saveCandidates, getCandidates, updateCandidateQuality, type StreamCandidate } from "../utils/candidates";

export interface Stream extends SdkStream {
  url: string;
  name: string;
  quality: string;
}

const SOURCES: Record<string, { label: string; base: string }> = {
  fc: { label: "Fútbol Libre", base: "https://www.futbollibre.tv" },
  cu: { label: "Cuevana", base: "https://cuevana3k.pro" },
};

/**
 * Stremio content types do not match the resolver workflow's target choices.
 * The workflow declares `target` as a choice of futbol/cine/series and
 * validates it, so translate before dispatching.
 */
const TARGET_BY_TYPE: Record<string, string> = {
  tv: "futbol",
  movie: "cine",
  series: "series",
};

/**
 * Attempts to resolve a TMDB ID from the content ID.
 * Returns { tmdbId, mediaType } or null if not resolvable.
 */
async function resolveTmdbId(env: Env, type: string, id: string): Promise<TmdbRef | null> {
  if (!env.TMDB_API_KEY) return null;
  
  const tmdb = new TmdbClient(env.TMDB_API_KEY);
  let value = id;

  for (const prefix of ["fc-", "cu-"]) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }

  // Strip Stremio video suffixes: `tt123:1:2` -> `tt123`.
  value = value.split(":")[0] ?? value;

  if (/^tt\d+$/.test(value)) {
    return tmdb.findByImdb(value);
  }
  if (/^\d+$/.test(value)) {
    return { tmdbId: Number(value), mediaType: type === "movie" ? "movie" : "tv" };
  }

  return null;
}

export async function resolveStreams(env: Env, type: string, id: string): Promise<Stream[]> {
  const kv = KvClient.fromEnv(env);

  // 0. Serve-time ranking: try stored candidates first (F4)
  const ranked = await rankAndResolveCandidates(env, type, id);
  if (ranked.length > 0) {
    console.log("DEBUG: Serving ranked candidates", { type, id, count: ranked.length });
    return ranked;
  }

  // 1. Check cache first (existing behavior)
  const cached = await kv.getStream(type, id);
  if (cached && isFresh(cached.ts) && cached.hls) {
    return sortByQuality([toStream(id, cached)]);
  }

  // 2. Handle Cuevana (cu-*) via GitHub Actions with VidHide extractor
  if (id.startsWith("cu-")) {
    const cuevanaId = id.slice(3); // Remove "cu-" prefix
    
    // For cu-* IDs, we need to fetch the Cuevana page to get tungtungsahur embed URLs
    // Then dispatch to GitHub Actions with vidhide extractor
    const embedUrl = await getCuevanaVidHideEmbedUrl(cuevanaId, type);
    if (embedUrl) {
      console.log("DEBUG: Dispatching cu-* to GitHub Actions with VidHide", { type, id, embedUrl });
      
      // Determine target for GitHub Actions: cine for movies, series for TV
      const target = type === "movie" ? "cine" : "series";
      await triggerResolveWorkflow(env, { 
        target: "vidhide",  // Use vidhide extractor type
        id, 
        url: embedUrl,
        stream_type: type  // Pass explicit type (movie|series) for correct KV key
      });

      const resolved = await pollForStream(kv, type, id);
      if (resolved) {
        return sortByQuality([toStream(id, resolved)]);
      }
    }
    
    // Fallback to Cuevana native extractor if no tungtungsahur URL found
    const extractor = new CuevanaExtractor();
    const result = await extractor.extract(cuevanaId);
    
    if (result.streams.length > 0) {
      const streams = result.streams.map((s) => ({
        url: rewriteToProxy(s.url),
        name: s.name,
        title: normalizeQuality(s.quality),
        quality: normalizeQuality(s.quality),
      }));
      console.log("DEBUG: Cuevana native streams found", { type, id, count: streams.length });
      
      // Persist all candidates for serve-time ranking (F3)
      const candidates: StreamCandidate[] = result.streams.map((s) => ({
        url: s.url,
        source: "cuevana-native",
        quality: normalizeQuality(s.quality),
        ts: Date.now(),
        embedUrl: s.url, // The original URL before proxy rewrite
      }));
      await saveCandidates(env, type, id, candidates);
      
      return sortByQuality(streams);
    }
    
    if (result.error) {
      console.warn("Cuevana native extractor failed", { id, error: result.error });
    }
  }

  // 3. Try Decryptor if TMDB ID is resolvable and DECRYPTOR_BASE_URL is configured
  const decryptorBaseUrl = env.DECRYPTOR_BASE_URL;
  if (decryptorBaseUrl) {
    const tmdbRef = await resolveTmdbId(env, type, id);
    if (tmdbRef) {
      const decryptor = new DecryptorClient(decryptorBaseUrl);
      let servers: DecryptorServer[] = [];
      
      if (tmdbRef.mediaType === "movie") {
        servers = await decryptor.fetchMovieStreams(tmdbRef.tmdbId);
      } else {
        // For TV/series, we need season/episode from the ID suffix (e.g., "fc-tt123:1:2")
        const parts = id.split(":");
        const season = parts[1] ? Number(parts[1]) : undefined;
        const episode = parts[2] ? Number(parts[2]) : undefined;
        
        if (season && episode) {
          servers = await decryptor.fetchTvStreams(tmdbRef.tmdbId, season, episode);
        }
      }

      if (servers.length > 0) {
        const label = sourceLabel(id);
        const streams = decryptorServersToStreams(servers, label).map(s => ({
          ...s,
          url: rewriteToProxy(s.url),
        }));
        console.log("DEBUG: Decryptor streams found", { type, id, count: streams.length });
        
        // Persist all candidates for serve-time ranking (F3)
        const candidates: StreamCandidate[] = servers
          .filter((s) => s.proxyUrl && s.type === "hls")
          .map((server) => ({
            url: server.proxyUrl,
            source: "decryptor",
            quality: normalizeQuality(server.quality),
            ts: Date.now(),
            embedUrl: server.proxyUrl,
          }));
        await saveCandidates(env, type, id, candidates);
        
        return sortByQuality(streams);
      }
    }
  }

  // 4. Fallback to existing resolver workflow
  const sourceUrl = await getEmbedUrlFromCatalog(kv, type, id);
  const target = TARGET_BY_TYPE[type] ?? type;
  console.log("DEBUG: resolveStreams fallback", { type, target, id, sourceUrl });
  await triggerResolveWorkflow(env, { target, id, url: sourceUrl });

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
  const url = rewriteToProxy(cache.hls);
  return {
    url,
    name: sourceLabel(id),
    title: quality,
    quality,
  };
}

/**
 * Rewrite CDN URLs that require session/headers to go through our video proxy.
 * This allows Stremio (running on user's device with their IP/cookies) to play
 * content from CDNs that block datacenter IPs but allow residential IPs.
 */
function rewriteToProxy(url: string): string {
  if (!url) return url;
  
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    
    // CDN domains that require proxy (block datacenter IPs, allow residential)
    const proxyDomains = [
      "flood.sourcerrr.online",
      "sacdn.hakunaymatata.com", 
      "noon.mooncase.online",
      "cloudorchestranova.com",
    ];
    
    if (proxyDomains.some(d => host.includes(d))) {
      // Rewrite to proxy: /proxy/video/?url=https://cdn.example.com/path
      const proxyUrl = new URL("/proxy/video/", "https://futbol-cuevana-addon.danielmamanidiaz.workers.dev");
      proxyUrl.searchParams.set("url", url);
      return proxyUrl.toString();
    }
  } catch {
    // Invalid URL, return as-is
  }
  
  return url;
}

/**
 * Source reliability ranking (higher = more reliable).
 * decryptor/vidhide-native first (validated by upstream), then cuevana-native,
 * then fallback resolver.
 */
function sourceRank(source: string): number {
  switch (source) {
    case "decryptor":
    case "vidhide-native":
      return 3;
    case "cuevana-native":
      return 2;
    default:
      return 1;
  }
}

/**
 * Resolves true quality for candidates and ranks them for serving.
 * Ranking: true resolution desc → source reliability → freshness (ts desc).
 * Returns the full ordered fallback list.
 */
async function rankAndResolveCandidates(
  env: Env,
  type: string,
  id: string,
): Promise<Stream[]> {
  const candidates = await getCandidates(env, type, id);
  if (!candidates.length) return [];

  // Resolve true quality for each candidate (parallel, with timeout)
  const resolved = await Promise.all(
    candidates.map(async (c) => {
      let trueQuality = c.quality;
      
      // Only fetch master playlist for HLS URLs
      if (/\.m3u8($|\?)/i.test(c.url)) {
        const fetchedQuality = await fetchTrueQuality(c.url);
        if (fetchedQuality && fetchedQuality !== "auto") {
          trueQuality = fetchedQuality;
          // Cache the resolved quality back (best-effort)
          await updateCandidateQuality(env, type, id, c.url, c.source, trueQuality);
        }
      }

      return {
        ...c,
        trueQuality,
        trueQualityRank: qualityRank(trueQuality),
      };
    })
  );

  // Rank: true resolution desc → source reliability → freshness (ts desc)
  resolved.sort((a, b) => {
    // 1. True quality (resolution) descending
    if (b.trueQualityRank !== a.trueQualityRank) {
      return b.trueQualityRank - a.trueQualityRank;
    }
    // 2. Source reliability (decryptor/vidhide-native first)
    const sourceDiff = sourceRank(b.source) - sourceRank(a.source);
    if (sourceDiff !== 0) return sourceDiff;
    // 3. Freshness (newer first)
    return b.ts - a.ts;
  });

  // Convert to Stream format for Stremio
  return resolved.map((c) => ({
    url: rewriteToProxy(c.url),
    name: `${sourceLabel(id)} · ${c.source}`,
    title: c.trueQuality,
    quality: c.trueQuality,
  }));
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

/**
 * Fetches a Cuevana page and extracts the first tungtungsahur embed URL
 * for the given language preference (Castellano > Latino > Subtitulado).
 */
async function getCuevanaVidHideEmbedUrl(cuevanaId: string, type: string): Promise<string | null> {
  try {
    // Determine the Cuevana URL based on type and ID
    const baseUrl = "https://cuevana3k.pro";
    let url: string;
    
    if (type === "movie") {
      url = `${baseUrl}/pelicula/${cuevanaId}`;
    } else {
      // For series/TV, the ID format might be "spider-noir/episodio-1x4"
      url = `${baseUrl}/serie/${cuevanaId}`;
    }

    console.log("DEBUG: Fetching Cuevana page for VidHide URL", { url });
    
    // Fetch with 10s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      console.warn("Failed to fetch Cuevana page", { url, status: res.status });
      return null;
    }

    const html = await res.text();
    
    // Extract tungtungsahur URLs from data-server attributes
    // Pattern: data-server="https://tungtungsahur.cuevana3k.pro/?token=..."
    // Priority: Castellano > Latino > Subtitulado
    // HTML structure: <li role="presentation" data-server="..."><span>Servidor Hyper</span><span>Reproducir</span>
    
    // Pattern 1: Look for tungtungsahur URLs in data-server attributes near "Servidor Hyper/Nebula" and "Reproducir"
    const pattern1 = /<li[^>]*data-server="([^"]*tungtungsahur[^"]*)"[^>]*>\s*<span[^>]*>Servidor\s+(?:Hyper|Nebula)[^<]*<\/span>\s*<span[^>]*>Reproducir<\/span>/gi;
    
    // Pattern 2: Any tungtungsahur URL in data-server attribute (fallback)
    const pattern2 = /<li[^>]*data-server="([^"]*tungtungsahur[^"]*)"[^>]*>/gi;
    
    // Pattern 3: Any tungtungsahur URL in data-server attribute (broad fallback)
    const pattern3 = /data-server="([^"]*tungtungsahur[^"]*)"/gi;

    const patterns = [pattern1, pattern2, pattern3];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(html)) !== null) {
        const tungtungsahurUrl = match[1];
        if (tungtungsahurUrl && tungtungsahurUrl.includes("tungtungsahur")) {
          console.log("DEBUG: Found tungtungsahur URL", { tungtungsahurUrl });
          return tungtungsahurUrl;
        }
      }
    }

    // Also check for base64 encoded URLs in data-server (?v=...)
    const base64Pattern = /data-server="[^"]*\?v=([^"&]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = base64Pattern.exec(html)) !== null) {
      const encoded = match[1];
      if (!encoded) continue;
      try {
        const decoded = atob(encoded);
        if (decoded.includes("tungtungsahur")) {
          console.log("DEBUG: Found tungtungsahur URL via base64", { decoded });
          return decoded;
        }
      } catch (e) {
        // Ignore decode errors
      }
    }

    return null;
  } catch (err) {
    console.warn("Failed to extract tungtungsahur URL", { cuevanaId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

interface CatalogItem {
  id: string;
  name: string;
  type: "movie" | "series" | "tv";
  poster: string;
  description?: string;
  embedUrl?: string;
}

import type { Stream as SdkStream } from "stremio-addon-sdk";
import type { Env } from "../index";
import { triggerResolveWorkflow } from "../clients/github";
import { KvClient, type StreamCache } from "../clients/kv";
import { DecryptorClient, decryptorServersToStreams, type DecryptorServer } from "../clients/decryptor";
import { TmdbClient, type TmdbRef } from "../clients/tmdb";
import { extractCuevanaServers, buildCuevanaPageUrl, type CuevanaServer } from "../extractors/cuevana";
import { MediaFlowClient, MEDIAFLOW_HOSTS, type MediaFlowHost } from "../clients/mediaflow";
import { POLL_ATTEMPTS, POLL_INTERVAL_MS, isFresh, logInfo, sleep } from "../utils/cache";
import { normalizeQuality, sortByQuality, fetchTrueQuality, qualityFromHeight, qualityRank } from "../utils/quality";
import { saveCandidates, getCandidates, updateCandidateQuality, type StreamCandidate } from "../utils/candidates";

export interface Stream extends SdkStream {
  url: string;
  name: string;
  quality: string;
}

/** Live Cuevana domain. The previous one (`cuevana3k.pro`) rotated away. */
const CUEVANA_BASE = "https://cuevana3r.pro";

const SOURCES: Record<string, { label: string; base: string }> = {
  fc: { label: "Fútbol Libre", base: "https://www.futbollibre.tv" },
  cu: { label: "Cuevana", base: CUEVANA_BASE },
};

/**
 * Stremio content types do not match the resolver workflow's target choices.
 * The workflow declares `target` as a single choice, `futbol`, and validates it,
 * so translate before dispatching. Only football still reaches the resolver:
 * Cuevana is resolved in-process by MediaFlow above.
 */
const TARGET_BY_TYPE: Record<string, "futbol"> = {
  tv: "futbol",
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

  // 2. Handle Cuevana (cu-*) through the MediaFlow Proxy.
  //
  // This branch is terminal on purpose. Cuevana has no legitimate fallback in the
  // resolver workflow: the catalog embedUrl would be built from the dash-split id
  // (which drops the /pelicula/ or /serie/ segment), and pollForStream would then
  // hang the client for POLL_ATTEMPTS * POLL_INTERVAL_MS with no chance of success.
  // An honest empty list is cheaper and faster than a doomed 3-minute poll.
  if (id.startsWith("cu-")) {
    const mediaflow = MediaFlowClient.fromEnv(env);

    if (!mediaflow) {
      logInfo("mediaflow_unconfigured", { type, id });
      return [];
    }

    const cuevanaId = id.slice(3); // Remove "cu-" prefix
    const pageUrl = buildCuevanaPageUrl(CUEVANA_BASE, cuevanaId, type);
    console.log("DEBUG: Fetching Cuevana page", { pageUrl });

    const { servers, error } = await extractCuevanaServers(pageUrl);
    if (error) console.warn("Cuevana page extraction failed", { id, error });

    const streams = await resolveCuevanaViaMediaFlow(mediaflow, servers);
    if (streams.length === 0) {
      logInfo("cuevana_unresolved", { type, id, servers: servers.length });
      return [];
    }

    console.log("DEBUG: MediaFlow streams found", { type, id, count: streams.length });

    // Persist candidates for serve-time ranking (F3)
    const candidates: StreamCandidate[] = streams.map((s, index) => ({
      url: s.url,
      source: "mediaflow",
      quality: s.quality,
      ts: Date.now() - index, // preserve the extraction preference order
      embedUrl: s.embedUrl,
    }));
    await saveCandidates(env, type, id, candidates);

    return sortByQuality(streams);
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

  // 4. Fallback to the resolver workflow. Only football still has one: the
  //    workflow's `target` choice is `futbol` alone, because MediaFlow resolves
  //    Cuevana in-process above. Dispatching an undeclared target makes GitHub
  //    reject the whole request, so bail out honestly instead.
  const target = TARGET_BY_TYPE[type];
  if (!target) {
    logInfo("no_resolver_for_type", { type, id });
    return [];
  }

  const sourceUrl = await getEmbedUrlFromCatalog(kv, type, id);
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
 * decryptor (validated upstream) first, then mediaflow (Cuevaana via MediaFlow Proxy).
 * Retired sources (vidhide-native, cuevana-native) fall to the default rank so stale
 * KV candidates cannot outrank a stream we just resolved successfully.
 */
function sourceRank(source: string): number {
  switch (source) {
    case "decryptor":
      return 3;
    case "mediaflow":
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
    // 2. Source reliability (decryptor first, then mediaflow)
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

/** Max extraction attempts per Cuevana page: 2 servers x 2 hosts, capped. */
const MAX_MEDIAFLOW_ATTEMPTS = 4;
const MEDIAFLOW_VALIDATE_TIMEOUT_MS = 8_000;

/** A resolved Cuevana stream, keeping the provenance its candidate entry needs. */
interface ResolvedCuevanaStream extends Stream {
  embedUrl: string;
  host: string;
  serverIndex: string;
}

/**
 * Validates each (server, host) pair against MediaFlow and returns the playable
 * ones in a deterministic order: document order first, then host preference.
 * Only validated streams are advertised, so the user never sees a dead source.
 */
async function resolveCuevanaViaMediaFlow(
  mediaflow: MediaFlowClient,
  servers: CuevanaServer[],
): Promise<ResolvedCuevanaStream[]> {
  const attempts: Array<{ server: CuevanaServer; host: MediaFlowHost }> = [];
  for (const server of servers) {
    for (const host of MEDIAFLOW_HOSTS) {
      if (attempts.length >= MAX_MEDIAFLOW_ATTEMPTS) break;
      attempts.push({ server, host });
    }
    if (attempts.length >= MAX_MEDIAFLOW_ATTEMPTS) break;
  }
  if (attempts.length === 0) return [];

  const checked = await Promise.all(
    attempts.map(async (attempt) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), MEDIAFLOW_VALIDATE_TIMEOUT_MS);
      try {
        const ok = await mediaflow.validate(attempt.server.embedUrl, attempt.host, controller.signal);
        return ok ? attempt : null;
      } finally {
        clearTimeout(timeoutId);
      }
    }),
  );

  const streams: ResolvedCuevanaStream[] = [];
  for (const attempt of checked) {
    if (!attempt) continue;
    streams.push({
      url: mediaflow.buildStreamUrl(attempt.server.embedUrl, attempt.host),
      name: `Cuevana · ${attempt.server.label}`,
      title: "auto",
      quality: "auto",
      embedUrl: attempt.server.embedUrl,
      host: attempt.host,
      serverIndex: attempt.server.serverIndex,
    });
  }
  return streams;
}

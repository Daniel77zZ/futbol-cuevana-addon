import { logError } from "../utils/cache";

export interface DecryptorServer {
  name: string;
  title: string;
  quality: string;
  proxyUrl: string;
  type: "hls" | "embed";
}

export interface DecryptorResponse {
  meta: { tmdb: number; type: string; season?: number; episode?: number };
  servers: DecryptorServer[];
}

/**
 * Minimal Decryptor API client built on `fetch` (Workers runtime).
 * Returns `null` on transport/API failure so callers can degrade gracefully.
 */
export class DecryptorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 8000,
  ) {}

  async fetchMovieStreams(tmdbId: number): Promise<DecryptorServer[]> {
    return this.fetchStreams(`/api/streams/movie/${tmdbId}`);
  }

  async fetchTvStreams(tmdbId: number, season: number, episode: number): Promise<DecryptorServer[]> {
    return this.fetchStreams(`/api/streams/tv/${tmdbId}?season=${season}&episode=${episode}`);
  }

  private async fetchStreams(path: string): Promise<DecryptorServer[]> {
    const url = `${this.baseUrl}${path}`;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!res.ok) {
        logError("decryptor_request_failed", { path, status: res.status });
        return [];
      }
      
      const data: DecryptorResponse = await res.json();
      return data.servers ?? [];
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        logError("decryptor_timeout", { path, timeoutMs: this.timeoutMs });
      } else {
        logError("decryptor_request_exception", { path, error: String(err) });
      }
      return [];
    }
  }
}

/**
 * Converts Decryptor servers to Stremio Stream format.
 * The proxyUrl from Decryptor already includes headers/referer via its /proxy endpoint.
 */
export function decryptorServersToStreams(
  servers: DecryptorServer[],
  baseLabel: string,
): Array<{ url: string; name: string; title: string; quality: string }> {
  return servers
    .filter((s) => s.proxyUrl && s.type === "hls")
    .map((server) => ({
      url: server.proxyUrl,
      name: `${baseLabel} · ${server.name}`,
      title: server.title || server.quality || "HD",
      quality: normalizeQuality(server.quality),
    }));
}

const QUALITY_ORDER = ["4k", "2160p", "1080p", "720p", "480p", "360p", "sd", "hd"];

function normalizeQuality(raw: string | undefined): string {
  const q = (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const idx = QUALITY_ORDER.findIndex((k) => q.includes(k));
  if (idx >= 0) return QUALITY_ORDER[idx] as string;
  return "hd";
}
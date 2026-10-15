/**
 * Quality normalization.
 *
 * Sources report quality in many shapes ("HD", "Full HD", "1080", "1080p",
 * "FHD", "4K"...). Stremio users expect stable labels, so we normalize
 * everything to one of the canonical values below.
 */

const QUALITY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(4k|2160p?|uhd)\b/i, "2160p"],
  [/\b(1440p?|2k|qhd)\b/i, "1440p"],
  [/\b(1080p?|fhd|full\s*hd)\b/i, "1080p"],
  [/\b(720p?)\b/i, "720p"],
  [/\b(480p?|sd)\b/i, "480p"],
  [/\b(360p?)\b/i, "360p"],
];

/** Canonical quality labels, best first. */
export const QUALITY_ORDER = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "auto"] as const;

/** Maps an arbitrary quality string to a canonical label. */
export function normalizeQuality(input?: string | null): string {
  if (!input) return "auto";

  const value = String(input).trim();
  if (value.length === 0) return "auto";

  for (const [pattern, label] of QUALITY_PATTERNS) {
    if (pattern.test(value)) return label;
  }

  // Bare "HD" (no height) is ambiguous; treat it as 720p, the usual meaning.
  if (/\bhd\b/i.test(value)) return "720p";

  // Anything left is not a resolution label we recognize, so it is noise
  // rather than a quality. Returning it verbatim puts garbage in front of the
  // user: extractors that scan the whole HLS URL pick digits out of the auth
  // token and report "1697p" or "7297p". "auto" is the honest label, and
  // qualityFromHeight() is the path for a real measured resolution.
  return "auto";
}

/** Derives a canonical label from a video height in pixels. */
export function qualityFromHeight(height?: number | null): string {
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return "auto";
  if (height >= 2000) return "2160p";
  if (height >= 1300) return "1440p";
  if (height >= 900) return "1080p";
  if (height >= 650) return "720p";
  if (height >= 420) return "480p";
  return "360p";
}

/** Higher is better. Unknown labels rank lowest. */
export function qualityRank(quality?: string | null): number {
  const normalized = normalizeQuality(quality);
  const index = (QUALITY_ORDER as readonly string[]).indexOf(normalized);
  return index === -1 ? -1 : QUALITY_ORDER.length - index;
}

/** Returns a new array sorted from best to worst quality. */
export function sortByQuality<T extends { quality?: string | null }>(streams: readonly T[]): T[] {
  return [...streams].sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
}

/**
 * Parses an HLS master playlist (#EXT-X-STREAM-INF) and returns the highest
 * variant's resolution (height in pixels) and bandwidth.
 * Returns null if no valid variants are found.
 */
export function parseMasterPlaylist(playlist: string): { height: number; bandwidth: number } | null {
  const lines = playlist.split("\n");
  let bestHeight = 0;
  let bestBandwidth = 0;
  let currentResolution: string | null = null;
  let currentBandwidth: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
      // Parse RESOLUTION=WIDTHxHEIGHT and BANDWIDTH=bits
      const resolutionMatch = trimmed.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bandwidthMatch = trimmed.match(/BANDWIDTH=(\d+)/i);
      
      if (resolutionMatch && resolutionMatch[1] && resolutionMatch[2]) {
        currentResolution = resolutionMatch[0];
        currentBandwidth = bandwidthMatch && bandwidthMatch[1] ? parseInt(bandwidthMatch[1], 10) : 0;
      }
    } else if (trimmed && !trimmed.startsWith("#") && currentResolution) {
      // This is a variant URI line - we have the metadata from the previous line
      const heightMatch = currentResolution.match(/x(\d+)$/i);
      if (heightMatch && heightMatch[1]) {
        const height = parseInt(heightMatch[1], 10);
        const bandwidth = currentBandwidth ?? 0;
        
        if (height > bestHeight || (height === bestHeight && bandwidth > bestBandwidth)) {
          bestHeight = height;
          bestBandwidth = bandwidth;
        }
      }
      // Reset for next variant
      currentResolution = null;
      currentBandwidth = null;
    }
  }

  if (bestHeight > 0) {
    return { height: bestHeight, bandwidth: bestBandwidth };
  }
  return null;
}

/**
 * Fetches and parses an HLS master playlist with a timeout.
 * Returns the canonical quality label from the highest variant, or null on failure.
 * 
 * @param url - The master playlist URL (must be http(s) and end with .m3u8)
 * @param timeoutMs - Fetch timeout in milliseconds (default: 5000)
 */
export async function fetchTrueQuality(
  url: string,
  timeoutMs: number = 5000
): Promise<string | null> {
  // Only process http(s) URLs ending in .m3u8
  if (!/^https?:\/\//i.test(url) || !/\.m3u8($|\?)/i.test(url)) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.apple.mpegurl,*/*" },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!res.ok) {
        return null;
      }
      
      const text = await res.text();
      const parsed = parseMasterPlaylist(text);
      
      if (parsed) {
        return qualityFromHeight(parsed.height);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    // Timeout, network error, or parse error - fail soft
    return null;
  }
}

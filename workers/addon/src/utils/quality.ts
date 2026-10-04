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

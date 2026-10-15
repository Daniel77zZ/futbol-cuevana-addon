/**
 * Candidate Store — persists ALL resolved streams per search with metadata.
 * Key family: `stream:candidates:<type>:<id>` (never collides with `stream:<type>:<id>`).
 * Each candidate: { url, source, quality, ts, embedUrl?, signatureParams? }.
 * Cap at 20 entries to bound KV value size; overwrite stale by url+source.
 */

import type { Env } from "../index";
import { KvClient } from "../clients/kv";

export interface StreamCandidate {
  /** Direct HLS/HTTP URL to play. */
  url: string;
  /** Source identifier (e.g., "cuevana-native", "decryptor", "vidhide"). */
  source: string;
  /** Normalized quality label (e.g., "1080p", "720p", "hd"). */
  quality: string;
  /** Unix epoch milliseconds when the candidate was stored. */
  ts: number;
  /** Optional embed URL that led to this candidate (for debugging/refresh). */
  embedUrl?: string;
  /** Optional signature parameters for signed URLs (e.g., vidlink tokens). */
  signatureParams?: Record<string, string>;
}

/** Maximum candidates stored per key to bound KV value size. */
const MAX_CANDIDATES = 20;

/** TTL for candidates (same as streams: 2 hours). */
const CANDIDATES_TTL_SECONDS = 2 * 60 * 60;

/** Builds the candidates KV key: `stream:candidates:<type>:<id>`. */
function candidatesKey(type: string, id: string): string {
  return `stream:candidates:${type}:${id}`;
}

/** Creates a unique fingerprint for deduplication (url + source). */
function candidateFingerprint(c: StreamCandidate): string {
  return `${c.url}|${c.source}`;
}

/**
 * Persists a list of candidates for a given type/id.
 * Deduplicates by (url, source), keeps newest, caps at MAX_CANDIDATES.
 */
export async function saveCandidates(
  env: Env,
  type: string,
  id: string,
  candidates: StreamCandidate[],
): Promise<void> {
  if (!candidates.length) return;

  const kv = KvClient.fromEnv(env);
  const key = candidatesKey(type, id);

  // Load existing to merge and deduplicate
  const existing = (await kv.getJson<StreamCandidate[]>(key)) ?? [];
  const now = Date.now();

  // Merge: prefer newer entries, dedupe by fingerprint
  const merged = new Map<string, StreamCandidate>();

  // Add existing first (older)
  for (const c of existing) {
    merged.set(candidateFingerprint(c), c);
  }

  // Add/overwrite with new candidates (newer timestamps win)
  for (const c of candidates) {
    const fp = candidateFingerprint(c);
    const existingCandidate = merged.get(fp);
    if (!existingCandidate || c.ts > existingCandidate.ts) {
      merged.set(fp, { ...c, ts: c.ts || now });
    }
  }

  // Sort by timestamp descending (newest first) and cap
  const sorted = Array.from(merged.values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_CANDIDATES);

  await kv.putJson(key, sorted, CANDIDATES_TTL_SECONDS);
}

/**
 * Retrieves stored candidates for a given type/id.
 * Returns empty array if none found or on error (degrades gracefully).
 */
export async function getCandidates(
  env: Env,
  type: string,
  id: string,
): Promise<StreamCandidate[]> {
  const kv = KvClient.fromEnv(env);
  const key = candidatesKey(type, id);
  return (await kv.getJson<StreamCandidate[]>(key)) ?? [];
}

/**
 * Updates a candidate's quality label in the stored candidates.
 * Best-effort write - never throws, logs errors silently.
 * Used to cache the true quality resolved from master playlist.
 */
export async function updateCandidateQuality(
  env: Env,
  type: string,
  id: string,
  candidateUrl: string,
  source: string,
  trueQuality: string,
): Promise<void> {
  try {
    const kv = KvClient.fromEnv(env);
    const key = candidatesKey(type, id);
    const candidates = (await kv.getJson<StreamCandidate[]>(key)) ?? [];
    
    const fingerprint = `${candidateUrl}|${source}`;
    const index = candidates.findIndex(c => `${c.url}|${c.source}` === fingerprint);
    
    if (index >= 0) {
      const existing = candidates[index]!;
      candidates[index] = {
        url: existing.url,
        source: existing.source,
        quality: trueQuality,
        ts: existing.ts,
        embedUrl: existing.embedUrl,
        signatureParams: existing.signatureParams,
      };
      await kv.putJson(key, candidates, CANDIDATES_TTL_SECONDS);
    }
  } catch {
    // Best-effort cache update - never fail the request on write errors
  }
}
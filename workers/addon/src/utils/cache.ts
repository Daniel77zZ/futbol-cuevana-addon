/**
 * Cache helpers: key builders, TTLs and small runtime utilities.
 *
 * KV keys are private to this addon and MUST stay stable because the GitHub
 * Actions workers write to the very same keys.
 */

/** Streams stay "fresh" for 2 hours; after that we re-resolve. */
export const STREAM_TTL_SECONDS = 2 * 60 * 60;
export const STREAM_MAX_AGE_MS = STREAM_TTL_SECONDS * 1000;

/** Catalogs are refreshed once a day by `daily-catalog.yml`. */
export const CATALOG_TTL_SECONDS = 24 * 60 * 60;

/** On-demand resolution polling: 15 attempts * 2s = 30s budget. */
export const POLL_ATTEMPTS = 15;
export const POLL_INTERVAL_MS = 2000;

export function streamKey(type: string, id: string): string {
  return `stream:${type}:${id}`;
}

export function catalogKey(type: string, id: string): string {
  return `catalog:${type}:${id}`;
}

/** A timestamp is fresh when it is a finite number younger than `maxAgeMs`. */
export function isFresh(ts: unknown, maxAgeMs: number = STREAM_MAX_AGE_MS): boolean {
  return typeof ts === "number" && Number.isFinite(ts) && Date.now() - ts < maxAgeMs;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Structured, greppable error logging for `wrangler tail`. */
export function logError(event: string, meta: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "error", event, ...meta, ts: new Date().toISOString() }));
}

export function logInfo(event: string, meta: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...meta, ts: new Date().toISOString() }));
}

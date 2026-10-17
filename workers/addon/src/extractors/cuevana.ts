/**
 * Cuevana3 page extractor.
 *
 * The old `api.cuevana3.io` endpoint is dead — the domain is parked, which is
 * why resolution silently stopped working. The live site (cuevana3r.pro) already
 * ships every player in a `data-server` attribute, so no API hop is needed: we
 * read the page and keep the entries whose payload is a tungtungsahur token.
 *
 * A page carries two kinds of `data-server`:
 *   - `?token=<base64>` -> decoded into `.lol/...` embed URLs. These are the ones
 *     MediaFlow can extract, and the only ones this module returns.
 *   - `?v=<base64>`     -> direct mirrors (vsembed.ru, vidlink.pro,
 *     player.videasy.net, vidapi.xyz). None are MediaFlow hosts, so they are
 *     deliberately ignored rather than half-supported.
 *
 * Document order matters: the first token server resolves to the `.lol/v/` form,
 * which is the reliable one, so callers must preserve the returned order.
 */
import { decodeToken, extractTokenFromUrl } from "./tungtungsahur";

/** One token-backed player offered by the page, in document order. */
export interface CuevanaServer {
  /** Decoded embed URL, e.g. `https://<host>.lol/v/abc123`. */
  embedUrl: string;
  /** Human label read from the page (e.g. `Hyper`), or `Cuevana` when absent. */
  label: string;
  /** Token prefix from the Cuevana token (`1`..`4`); kept for debugging. */
  serverIndex: string;
}

export interface CuevanaPageResult {
  servers: CuevanaServer[];
  error?: string;
}

/** `<li ... data-server="<payload>">` — payload still holds the token or `?v=`. */
const DATA_SERVER_PATTERN = /data-server="([^"]*tungtungsahur[^"]*)"/gi;

/** `<li ... data-server="..."><span>Servidor Hyper</span>` -> `Hyper`. */
const SERVER_LABEL_PATTERN = /data-server="[^"]*"[^>]*>\s*<span[^>]*>\s*Servidor\s+([^<]+?)\s*<\/span>/i;

/** The site serves different markup to non-browser clients. */
const FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9",
};

/**
 * Builds the Cuevana page URL for a Stremio `cu-` content ID.
 * Movies live under `/pelicula/<slug>`; series and episodes under `/serie/<slug>`.
 */
export function buildCuevanaPageUrl(base: string, cuevanaId: string, type: string): string {
  const cleanBase = base.replace(/\/+$/, "");
  const slug = cuevanaId.replace(/^\/+/, "");
  return type === "movie" ? `${cleanBase}/pelicula/${slug}` : `${cleanBase}/serie/${slug}`;
}

/** Fetches a Cuevana page and returns its token servers, in document order. */
export async function extractCuevanaServers(
  pageUrl: string,
  signal?: AbortSignal,
): Promise<CuevanaPageResult> {
  try {
    const res = await fetch(pageUrl, { headers: FETCH_HEADERS, redirect: "follow", signal });
    if (!res.ok) {
      return { servers: [], error: `page fetch failed: ${res.status}` };
    }
    return { servers: parseCuevanaServers(await res.text()) };
  } catch (err) {
    return { servers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Pure parser, exported so it can be exercised without network access. */
export function parseCuevanaServers(html: string): CuevanaServer[] {
  const servers: CuevanaServer[] = [];
  const seen = new Set<string>();

  // The pattern carries /g, so its cursor must be reset before each use.
  DATA_SERVER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = DATA_SERVER_PATTERN.exec(html)) !== null) {
    const raw = match[1];
    if (!raw || !raw.includes("?token=")) continue; // skip the `?v=` direct mirrors

    const token = extractTokenFromUrl(raw);
    if (!token || seen.has(token)) continue;

    try {
      servers.push({
        embedUrl: decodeToken(token),
        label: readLabelNear(html, match.index, raw),
        serverIndex: token.charAt(0),
      });
      seen.add(token);
    } catch {
      // Undecodable token: skip this server instead of failing the whole page.
    }
  }

  return servers;
}

/** Reads the `Servidor <name>` label that follows a given `data-server`. */
function readLabelNear(html: string, index: number, raw: string): string {
  const window = html.slice(index, index + raw.length + 200);
  return window.match(SERVER_LABEL_PATTERN)?.[1]?.trim() || "Cuevana";
}

/**
 * Cloudflare Worker entry point for the Fútbol Libre + Cuevana Stremio addon.
 *
 * Routes (Stremio protocol endpoints, all `.json`-suffixed):
 *   GET /manifest.json
 *   GET /stream/:type/:id.json
 *   GET /meta/:type/:id.json
 *   GET /catalog/:type/:id.json
 *   GET /catalog/:type/:id/:extra.json
 */
import { generateManifest } from "./manifest";
import { getCatalog } from "./routes/catalog";
import { getMeta } from "./routes/meta";
import { resolveStreams } from "./routes/stream";
import { logError } from "./utils/cache";

/** Bindings, vars and secrets available to the Worker (see wrangler.toml). */
export interface Env {
  /** KV namespace binding. */
  STREAMS_KV: KVNamespace;
  /** TMDB API key (secret). */
  TMDB_API_KEY: string;
  /** GitHub token with `actions:write` (secret). */
  GH_TOKEN: string;
  /** Target repository, e.g. "user/futbol-cuevana-addon". */
  GH_REPO: string;
  /** Workflow file to dispatch, e.g. "resolve-on-demand.yml". */
  GH_WORKFLOW: string;
  /** Branch/ref the workflow runs on. Defaults to "main". */
  GH_REF?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const VALID_TYPES = new Set(["movie", "series", "tv"]);
const VALID_RESOURCES = new Set(["stream", "meta", "catalog"]);

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Dynamic, on-demand content: never let intermediaries cache it.
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ err: message }, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight (Stremio Web fetches from the browser).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse("Method not allowed", 405);
    }

    const { pathname } = new URL(request.url);

    try {
      if (pathname === "/" || pathname === "/manifest.json") {
        return jsonResponse(generateManifest());
      }

      const segments = pathname.split("/").filter(Boolean);
      const resource = segments[0];
      const type = segments[1];
      if (!resource || !type || segments.length < 3) {
        return errorResponse("Not found", 404);
      }
      if (!VALID_RESOURCES.has(resource)) {
        return errorResponse("Not found", 404);
      }
      if (!VALID_TYPES.has(type)) {
        return errorResponse(`Unsupported type: ${type}`, 400);
      }

      // Everything after /:resource/:type/, minus the trailing `.json`.
      const rest = segments.slice(2).join("/").replace(/\.json$/i, "");
      if (!rest) return errorResponse("Missing id", 400);

      const { id, extra } = splitIdAndExtra(resource, rest);

      switch (resource) {
        case "stream":
          return jsonResponse({ streams: await resolveStreams(env, type, id) });
        case "meta":
          return jsonResponse({ meta: await getMeta(env, type, id) });
        case "catalog":
          return jsonResponse({ metas: await getCatalog(env, type, id, extra) });
        default:
          return errorResponse("Not found", 404);
      }
    } catch (err) {
      logError("unhandled_request_error", { pathname, error: String(err) });
      return errorResponse("Internal server error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Splits the path remainder into `id` and Stremio `extra`.
 *
 * Only catalogs carry an extra segment: `/catalog/tv/futbol/search=foo.json`.
 * `skip` extra is also represented as a path segment in some clients.
 */
function splitIdAndExtra(
  resource: string,
  rest: string,
): { id: string; extra: Record<string, string> } {
  if (resource !== "catalog") return { id: rest, extra: {} };

  const slash = rest.indexOf("/");
  if (slash === -1) return { id: rest, extra: {} };

  return {
    id: rest.slice(0, slash),
    extra: parseExtra(rest.slice(slash + 1)),
  };
}

/** Parses either a URL-encoded JSON blob or a `key=value&key2=value2` string. */
function parseExtra(raw?: string): Record<string, string> {
  const extra: Record<string, string> = {};
  if (!raw) return extra;

  const decoded = safeDecode(raw);

  if (decoded.startsWith("{")) {
    try {
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) extra[key] = String(value);
      }
      return extra;
    } catch {
      // Fall through to the key=value parser.
    }
  }

  for (const part of decoded.split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    extra[part.slice(0, eq)] = part.slice(eq + 1);
  }

  return extra;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

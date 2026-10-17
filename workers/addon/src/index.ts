/**
 * Cloudflare Worker entry point for the Fútbol Libre + Cuevana Stremio addon.
 *
 * Routes (Stremio protocol endpoints, all `.json`-suffixed):
 *   GET /manifest.json
 *   GET /stream/:type/:id.json
 *   GET /meta/:type/:id.json
 *   GET /catalog/:type/:id.json
 *   GET /catalog/:type/:id/:extra.json
 *   GET /debug/catalog
 *   GET /debug/stream
 */
import { generateManifest } from "./manifest";
import { getCatalog } from "./routes/catalog";
import { getMeta } from "./routes/meta";
import { resolveStreams } from "./routes/stream";
import { debugCatalog, debugStream, debugCandidates } from "./routes/debug";
import { logError } from "./utils/cache";

/** Bindings, vars and secrets available to the Worker (see wrangler.toml). */
export interface Env {
  /** KV namespace binding. */
  STREAMS_KV: KVNamespace;
  /** TMDB API key (secret). */
  TMDB_API_KEY: string;
  /** GitHub token with `actions:write` (secret). */
  GH_TOKEN: string;
  /** Target repository in "owner/name" form, e.g. "Daniel77zZ/futbol-cuevana-addon". */
  GH_REPO: string;
  /** Workflow file to dispatch, e.g. "resolve-on-demand.yml". */
  GH_WORKFLOW: string;
  /** Branch/ref the workflow runs on. Defaults to "main". */
  GH_REF?: string;
  /** Decryptor API base URL (e.g., https://your-decryptor.railway.app). */
  DECRYPTOR_BASE_URL?: string;
  /** MediaFlow Proxy base URL (e.g., https://mediaflow.example.com). */
  MEDIAFLOW_BASE?: string;
  /** MediaFlow Proxy API password (secret), when the instance enforces one. */
  MEDIAFLOW_API_PASSWORD?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const VALID_TYPES = new Set(["movie", "series", "tv"]);
const VALID_RESOURCES = new Set(["stream", "meta", "catalog", "debug"]);

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
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
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse("Method not allowed", 405);
    }

    const { pathname } = new URL(request.url);

    // Handle video proxy for CDN URLs that require session/headers
    if (pathname.startsWith("/proxy/video/")) {
      return handleVideoProxy(request);
    }

    try {
      if (pathname === "/" || pathname === "/manifest.json") {
        return jsonResponse(generateManifest());
      }

      // Handle debug endpoints first (before Stremio routing)
      if (pathname.startsWith("/debug/")) {
        const debugSegments = pathname.replace(/^\/debug\//, "").split("/");
        const debugType = debugSegments[0];
        const debugId = debugSegments[1] || "";
        
        if (debugType === "catalog") {
          return jsonResponse(await debugCatalog(env, debugType, debugId));
        }
        if (debugType === "stream") {
          return jsonResponse(await debugStream(env, debugType, debugId));
        }
        if (debugType === "candidates") {
          const type = debugSegments[1] || "movie";
          const id = debugSegments[2] || "";
          if (!id) return errorResponse("Missing id", 400);
          return jsonResponse(await debugCandidates(env, type, id));
        }
        return errorResponse("Not found", 404);
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
        return errorResponse("Unsupported type: " + type, 400);
      }

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

/**
 * Video proxy handler for CDN URLs that require session cookies/headers.
 * Proxies requests to CDN (flood.sourcerrr.online, sacdn.hakunaymatata.com, etc.)
 * with the original client's headers (Referer, Origin, Cookie, User-Agent, Range).
 * 
 * Usage: /proxy/video/?url=https://cdn.example.com/path
 */
async function handleVideoProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  // Get target URL from query parameter (cleaner than path encoding)
  const targetUrl = url.searchParams.get("url");
  
  if (!targetUrl) {
    return new Response("Missing target URL (use ?url=...)", { status: 400 });
  }
  
  try {
    // Validate target is a known CDN domain (security)
    const targetHost = new URL(targetUrl).hostname;
    const allowedDomains = [
      "flood.sourcerrr.online",
      "sacdn.hakunaymatata.com",
      "noon.mooncase.online",
      "cloudorchestranova.com",
    ];
    
    if (!allowedDomains.some(d => targetHost.includes(d))) {
      return new Response("CDN domain not allowed", { status: 403 });
    }
    
    // Build headers to forward to CDN
    const headers = new Headers();
    
    // Forward critical headers from original request
    const forwardHeaders = [
      "referer",
      "origin", 
      "cookie",
      "user-agent",
      "range",           // For video seeking
      "accept",
      "accept-language",
      "accept-encoding",
    ];
    
    for (const h of forwardHeaders) {
      const value = request.headers.get(h);
      if (value) headers.set(h, value);
    }
    
    // Set Referer/Origin to CDN base if not provided
    if (!headers.has("referer")) {
      headers.set("referer", "https://vidlink.pro/");
    }
    if (!headers.has("origin")) {
      headers.set("origin", "https://vidlink.pro");
    }
    
    // Forward the request to CDN
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      redirect: "follow",
    });
    
    // Stream the response back with CORS headers
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, Content-Type, Authorization");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
    responseHeaders.set("Accept-Ranges", "bytes");
    
    // Remove problematic headers
    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("x-frame-options");
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
    
  } catch (err) {
    console.error("Video proxy error:", err);
    return new Response("Proxy error", { status: 502 });
  }
}

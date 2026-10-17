/**
 * TungTungSahur token decoder - XOR decodes the token from cuevana3 redirect
 * Compatible with Cloudflare Workers (fetch-only, no browser)
 */

const XOR_KEY = "a45f04ce-2394-47c3-b718-0ecd97ce51d6";

/**
 * Server prefixes mapping from the token's first character
 * 1 = lkhjerbhye3wjkhodvh5xiczuvd.lol/v/
 * 2 = filemoon.sx/e/
 * 3 = lkhjerbhye3wjkhodvh5xlczuvd.lol/e/
 * 4 = dood.li/e/
 */
const SERVERS: Record<string, string> = {
  "1": "https://lkhjerbhye3wjkhodvh5xiczuvd.lol/v/",
  "2": "https://filemoon.sx/e/",
  "3": "https://lkhjerbhye3wjkhodvh5xlczuvd.lol/e/",
  "4": "https://dood.li/e/",
};

/**
 * Decodes a TungTungSahur token using XOR with the fixed key.
 * @param token - Token string (e.g., "1D0VEA0dMAQ1AVVdW")
 * @returns Full embed URL (e.g., "https://lkhjerbhye3wjkhodvh5xiczuvd.lol/v/nqqewxbhmgdo")
 * @throws Error if token format is invalid
 */
export function decodeToken(token: string): string {
  if (!token || token.length < 2) {
    throw new Error("Invalid token: too short");
  }

  const prefix = token.charAt(0);
  const b64 = token.slice(1);

  if (!prefix || !SERVERS[prefix]) {
    throw new Error(`Unknown server prefix: ${prefix ?? "empty"}`);
  }

  // Decode base64
  let decoded: string;
  try {
    // Cloudflare Workers has atob globally
    decoded = atob(b64);
  } catch {
    throw new Error("Invalid token: base64 decode failed");
  }

  // XOR decode
  let result = "";
  for (let i = 0; i < decoded.length; i++) {
    result += String.fromCharCode(
      decoded.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
    );
  }

  return `${SERVERS[prefix]}${result}`;
}

/**
 * Extracts token from a tungtungsahur URL.
 * URL format: https://tungtungsahur.cuevana3k.pro/?token=X
 */
export function extractTokenFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token");
  } catch {
    return null;
  }
}

/**
 * Full flow: given a tungtungsahur URL, extract and decode token to get embed URL.
 */
export async function resolveEmbedUrl(tungtungsahurUrl: string): Promise<string> {
  const token = extractTokenFromUrl(tungtungsahurUrl);
  if (!token) {
    throw new Error("No token found in tungtungsahur URL");
  }
  return decodeToken(token);
}
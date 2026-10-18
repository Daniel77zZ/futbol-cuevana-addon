/**
 * Datacenter-IP probe for the Cuevana -> MediaFlow path.
 *
 * The local end-to-end test ran from a residential IP. Any public host is a
 * datacenter IP, and some CDNs serve residential clients while refusing
 * datacenter ranges. This script answers that question from wherever it runs:
 * it resolves a real Cuevana page with the Worker's own extractor, asks
 * MediaFlow to extract the embed, pulls the rewritten manifest, and downloads
 * the first bytes of a segment.
 *
 * It also answers a second question the docs leave open: whether the rewritten
 * manifest points its segments back through MediaFlow (egress through the host)
 * or straight at the CDN (egress is the client's).
 *
 * Usage, from `workers/addon`:
 *   MEDIAFLOW_BASE=http://127.0.0.1:8888 npx tsx scripts/probe-datacenter.ts [slug...]
 *
 * Exit code 0 means the full path worked from this IP. Non-zero means it did
 * not, and the printed stage says where it broke.
 */

import { buildCuevanaPageUrl, extractCuevanaServers } from "../src/extractors/cuevana";
import { MEDIAFLOW_HOSTS, MediaFlowClient } from "../src/clients/mediaflow";
import type { Env } from "../src/index";

const CUEVANA_BASE = "https://cuevana3r.pro";
const DEFAULT_SLUGS = ["apuntes-para-una-ficcion-consentida"];

const mediaflowBase = (process.env.MEDIAFLOW_BASE ?? "http://127.0.0.1:8888").replace(/\/+$/, "");
const apiPassword = process.env.API_PASSWORD ?? "";

const client = MediaFlowClient.fromEnv({
  MEDIAFLOW_BASE: mediaflowBase,
  MEDIAFLOW_API_PASSWORD: apiPassword,
} as unknown as Env);

// A push-triggered run passes no inputs, which arrives as an empty argument
// rather than as no argument. Filter those out so the defaults still apply.
const args = process.argv.slice(2).filter((arg) => arg.trim().length > 0);
const slugs = args.length > 0 ? args : DEFAULT_SLUGS;

function hostOf(url: string, base?: string): string {
  try {
    return new URL(url, base).host;
  } catch {
    return "(unparseable)";
  }
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 160);
}

/** Returns true only when a real manifest and a real segment byte range came back. */
async function probeHost(embedUrl: string, host: (typeof MEDIAFLOW_HOSTS)[number]): Promise<boolean> {
  if (!client) {
    console.error("  MEDIAFLOW_BASE is not set");
    return false;
  }

  try {
    return await probeHostUnsafe(embedUrl, host);
  } catch (err) {
    // An unreachable MediaFlow must read as a failed probe, not as a crash:
    // the point of this script is to report where the path broke.
    console.log(`  [${host}] threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function probeHostUnsafe(
  embedUrl: string,
  host: (typeof MEDIAFLOW_HOSTS)[number],
): Promise<boolean> {
  if (!client) return false;

  const playlistUrl = client.buildStreamUrl(embedUrl, host);

  // Stage 1 -- the endpoint the docs say answers with a 302 to the rewritten
  // manifest. Reading it without following proves the redirect exists.
  const redirect = await fetch(playlistUrl, { redirect: "manual" });
  const location = redirect.headers.get("location");
  console.log(
    `  [${host}] playlist: HTTP ${redirect.status}` +
      (location ? ` -> ${hostOf(location, playlistUrl)}` : " (no location header)"),
  );

  // Stage 2 -- follow it and inspect the manifest MediaFlow rewrote.
  const manifestRes = await fetch(playlistUrl, { redirect: "follow" });
  const manifest = await manifestRes.text();
  const isHls = manifest.includes("#EXTM3U");
  const segments = manifest
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  console.log(
    `  [${host}] manifest: HTTP ${manifestRes.status}, ${manifest.length}B, ` +
      `#EXTM3U=${isHls}, segments=${segments.length}`,
  );

  if (!isHls) {
    console.log(`  [${host}] body: ${preview(manifest) || "(empty)"}`);
    return false;
  }

  const firstSegment = segments[0];
  if (!firstSegment) {
    console.log(`  [${host}] manifest carries no segment lines`);
    return false;
  }

  // Stage 3 -- where do the segments point? Through MediaFlow (host egress) or
  // at the CDN directly (client egress)?
  const segmentHost = hostOf(firstSegment, manifestRes.url);
  const proxied = segmentHost === hostOf(playlistUrl);
  console.log(`  [${host}] first segment host: ${segmentHost} (proxied_through_mediaflow=${proxied})`);

  // Stage 4 -- prove bytes actually flow from this IP.
  const segmentRes = await fetch(new URL(firstSegment, manifestRes.url).toString(), {
    headers: { Range: "bytes=0-2047" },
  });
  const bytes = new Uint8Array(await segmentRes.arrayBuffer());
  console.log(
    `  [${host}] segment: HTTP ${segmentRes.status}, ${bytes.length}B, ` +
      `type=${segmentRes.headers.get("content-type") ?? "?"}`,
  );

  return segmentRes.ok && bytes.length > 0;
}

async function main(): Promise<number> {
  console.log(`MediaFlow base: ${mediaflowBase}`);
  console.log(`Cuevana base : ${CUEVANA_BASE}`);

  let anySuccess = false;

  for (const slug of slugs) {
    const pageUrl = buildCuevanaPageUrl(CUEVANA_BASE, slug, "movie");
    console.log(`\n=== ${pageUrl}`);

    const page = await extractCuevanaServers(pageUrl);
    if (page.error) console.log(`  page error: ${page.error}`);
    console.log(`  token servers: ${page.servers.length}`);

    const embed = page.servers[0]?.embedUrl;
    if (!embed) {
      console.log("  no token server found on the page -- nothing to extract");
      continue;
    }
    console.log(`  embed: ${embed}`);

    for (const host of MEDIAFLOW_HOSTS) {
      const worked = await probeHost(embed, host);
      if (worked) anySuccess = true;
    }
  }

  console.log(`\n=== RESULT: ${anySuccess ? "PASS" : "FAIL"}`);
  return anySuccess ? 0 : 1;
}

process.exit(await main());

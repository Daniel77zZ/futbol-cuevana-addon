import type { Manifest } from "stremio-addon-sdk";

/**
 * The addon manifest.
 *
 * We use the SDK's `Manifest` type for compile-time validation, but we do NOT
 * import the SDK at runtime: `stremio-addon-sdk`'s entrypoint pulls in express
 * and node-fetch, which cannot run inside a Cloudflare Worker. A type-only
 * import (`import type`) is erased by esbuild during `wrangler deploy`.
 */
export const MANIFEST: Manifest = {
  id: "org.futbol-cuevana.addon",
  version: "1.0.0",
  name: "Fútbol Libre + Cuevana",
  description:
    "Fútbol en vivo, cine y series desde Fútbol Libre y Cuevana. Los enlaces se resuelven on-demand a través de GitHub Actions y se cachean en Cloudflare KV.",
  logo: "https://raw.githubusercontent.com/Stremio/stremio-art/main/originals/placeholder.png",
  resources: ["stream", "meta", "catalog"],
  types: ["movie", "series", "tv"],
  idPrefixes: ["fc-", "cu-"],
  catalogs: [
    {
      type: "tv",
      id: "futbol",
      name: "Fútbol en vivo",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "movie",
      id: "cine",
      name: "Cine",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
    },
    {
      type: "series",
      id: "series",
      name: "Series",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
    },
  ],
  behaviorHints: {
    adult: false,
    configurable: false,
  },
};

export function generateManifest(): Manifest {
  return MANIFEST;
}

/**
 * MediaFlow Proxy client.
 *
 * MediaFlow (https://github.com/mhdzumair/mediaflow-proxy) owns both the
 * extraction step and the HLS manifest proxying. This client only builds the
 * URLs it consumes and asks it whether an embed is actually playable, so the
 * Worker stays a thin resolver.
 *
 * Two endpoints matter:
 *   - `GET /extractor/video`      -> JSON, used for validation (`destination_url`).
 *   - `GET /extractor/video.m3u8` -> 302 to the proxied, child-rewritten manifest.
 *
 * The `.m3u8` path extension is intentional: it makes ExoPlayer (the player most
 * Android Stremio clients use) pick an HLS source instead of guessing.
 */
import type { Env } from "../index";

/** Extractor names known to handle the Cuevana `.lol` embeds, in preference order. */
export const MEDIAFLOW_HOSTS = ["StreamHG", "StreamWish"] as const;

export type MediaFlowHost = (typeof MEDIAFLOW_HOSTS)[number];

export class MediaFlowClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly apiPassword?: string,
  ) {}

  /** Returns `null` when `MEDIAFLOW_BASE` is not configured. */
  static fromEnv(env: Env): MediaFlowClient | null {
    const base = env.MEDIAFLOW_BASE?.trim();
    if (!base) return null;
    return new MediaFlowClient(base.replace(/\/+$/, ""), env.MEDIAFLOW_API_PASSWORD || undefined);
  }

  /**
   * URL handed to Stremio. Playable only if the extractor behind `host` supports
   * the embed, which is what {@link validate} is for.
   */
  buildStreamUrl(embedUrl: string, host: MediaFlowHost): string {
    const params = new URLSearchParams({
      host,
      d: embedUrl,
      redirect_stream: "true",
    });
    if (this.apiPassword) params.set("api_password", this.apiPassword);
    return `${this.baseUrl}/extractor/video.m3u8?${params.toString()}`;
  }

  /**
   * Asks MediaFlow to extract `embedUrl` for real. Never throws: any network,
   * HTTP or JSON failure reads as "not playable".
   *
   * The `.m3u8` check is mandatory, not a nicety — some extractors report
   * success while returning a non-video URL (for example an image-slides API),
   * which would surface a broken source to the user.
   */
  async validate(embedUrl: string, host: MediaFlowHost, signal?: AbortSignal): Promise<boolean> {
    const params = new URLSearchParams({ host, d: embedUrl });
    if (this.apiPassword) params.set("api_password", this.apiPassword);

    try {
      const res = await fetch(`${this.baseUrl}/extractor/video?${params.toString()}`, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { destination_url?: unknown };
      return typeof body.destination_url === "string" && body.destination_url.includes(".m3u8");
    } catch {
      return false;
    }
  }
}

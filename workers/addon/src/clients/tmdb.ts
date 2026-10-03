import { logError } from "../utils/cache";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbMovie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  genres?: TmdbGenre[];
}

export interface TmdbTv {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string;
  vote_average: number;
  genres?: TmdbGenre[];
}

export interface TmdbFindResult {
  movie_results: Array<{ id: number }>;
  tv_results: Array<{ id: number }>;
}

export interface TmdbRef {
  tmdbId: number;
  mediaType: "movie" | "tv";
}

/**
 * Minimal TMDB client built on `fetch` (Workers runtime, no node-fetch).
 * Every method returns `null` on transport/API failure so callers can degrade
 * to a bare meta response instead of erroring.
 */
export class TmdbClient {
  constructor(
    private readonly apiKey: string,
    private readonly language: string = "es-ES",
    private readonly baseUrl: string = TMDB_BASE_URL,
  ) {}

  async getMovie(id: number): Promise<TmdbMovie | null> {
    return this.get<TmdbMovie>(`/movie/${id}`);
  }

  async getTv(id: number): Promise<TmdbTv | null> {
    return this.get<TmdbTv>(`/tv/${id}`);
  }

  /** Resolves an IMDb id (`tt1234567`) to a TMDB id + media type. */
  async findByImdb(imdbId: string): Promise<TmdbRef | null> {
    const data = await this.get<TmdbFindResult>(`/find/${imdbId}`, {
      external_source: "imdb_id",
    });
    if (!data) return null;

    const movie = data.movie_results?.[0];
    if (movie) return { tmdbId: movie.id, mediaType: "movie" };

    const tv = data.tv_results?.[0];
    if (tv) return { tmdbId: tv.id, mediaType: "tv" };

    return null;
  }

  imageUrl(path: string | null | undefined, size = "w500"): string | undefined {
    return path ? `${TMDB_IMAGE_BASE}/${size}${path}` : undefined;
  }

  private async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("api_key", this.apiKey);
    url.searchParams.set("language", this.language);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    try {
      const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!res.ok) {
        logError("tmdb_request_failed", { path, status: res.status });
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      logError("tmdb_request_exception", { path, error: String(err) });
      return null;
    }
  }
}

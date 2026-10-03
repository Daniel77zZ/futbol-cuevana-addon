import type { MetaDetail } from "stremio-addon-sdk";
import type { Env } from "../index";
import { TmdbClient, type TmdbRef } from "../clients/tmdb";
import { logError } from "../utils/cache";

const ID_PREFIXES = ["fc-", "cu-"];

/**
 * Returns TMDB-enriched metadata for a prefixed id.
 *
 * Supported id shapes (after stripping `fc-`/`cu-` and any `:season:episode`
 * suffix): a numeric TMDB id, or an IMDb id (`tt...`). Anything else yields
 * `null`, which Stremio treats as "no meta".
 */
export async function getMeta(env: Env, type: string, id: string): Promise<MetaDetail | null> {
  if (!env.TMDB_API_KEY) {
    logError("meta_missing_tmdb_key", { type, id });
    return null;
  }

  const tmdb = new TmdbClient(env.TMDB_API_KEY);

  try {
    const ref = await resolveTmdbRef(tmdb, id, type);
    if (!ref) return null;

    if (ref.mediaType === "movie") {
      const movie = await tmdb.getMovie(ref.tmdbId);
      if (!movie) return null;
      return {
        id,
        type: "movie",
        name: movie.title,
        poster: tmdb.imageUrl(movie.poster_path, "w500"),
        background: tmdb.imageUrl(movie.backdrop_path, "w1280"),
        description: movie.overview || undefined,
        releaseInfo: year(movie.release_date),
        imdbRating: rating(movie.vote_average),
        genres: movie.genres?.map((genre) => genre.name),
      };
    }

    const show = await tmdb.getTv(ref.tmdbId);
    if (!show) return null;
    return {
      id,
      type: "series",
      name: show.name,
      poster: tmdb.imageUrl(show.poster_path, "w500"),
      background: tmdb.imageUrl(show.backdrop_path, "w1280"),
      description: show.overview || undefined,
      releaseInfo: year(show.first_air_date),
      imdbRating: rating(show.vote_average),
      genres: show.genres?.map((genre) => genre.name),
    };
  } catch (err) {
    logError("meta_exception", { type, id, error: String(err) });
    return null;
  }
}

async function resolveTmdbRef(tmdb: TmdbClient, rawId: string, type: string): Promise<TmdbRef | null> {
  let value = rawId;

  for (const prefix of ID_PREFIXES) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }

  // Strip Stremio video suffixes: `tt123:1:2` -> `tt123`.
  value = value.split(":")[0] ?? value;

  if (/^tt\d+$/.test(value)) {
    return tmdb.findByImdb(value);
  }
  if (/^\d+$/.test(value)) {
    return { tmdbId: Number(value), mediaType: type === "movie" ? "movie" : "tv" };
  }

  return null;
}

function year(date: string | undefined): string | undefined {
  return date && date.length >= 4 ? date.slice(0, 4) : undefined;
}

function rating(average: number | undefined): string | undefined {
  return typeof average === "number" && average > 0 ? average.toFixed(1) : undefined;
}

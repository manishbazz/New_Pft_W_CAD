/**
 * "Now playing" endpoint for the portfolio site.
 *
 * GET /            -> { isPlaying, title, artist, album?, albumArt?, songUrl?,
 *                       progressMs?, durationMs?, playedAt? }
 *                    isPlaying=false + the last played track when nothing is on.
 * GET /login       -> (SETUP_MODE=1 only) start Spotify authorisation
 * GET /callback    -> (SETUP_MODE=1 only) shows your refresh token once
 *
 * Why a Worker: the portfolio is a static GitHub Pages site and can't hold
 * the Spotify client secret / refresh token. They live here as Cloudflare
 * secrets; the browser only ever sees the small public JSON above.
 *
 * Two data sources:
 *   - Spotify Web API (needs Spotify Premium for a Development Mode app
 *     since Feb 2026): currently-playing, else recently-played.
 *   - Last.fm (works with free Spotify via Spotify -> Last.fm scrobbling):
 *     used when LASTFM_USER and LASTFM_API_KEY are set.
 *
 * Responses are cached at the edge for 15 s, so many visitors cost at most
 * ~4 upstream calls a minute.
 *
 * "Last played" accuracy (Spotify route): Spotify's recently-played list
 * only records tracks played to the END. A song you stop or skip midway
 * never appears there, so the card used to fall back to whatever you last
 * finished, often hours old. With the optional LAST_SEEN KV binding, the
 * worker remembers the last track it actually saw in currently-playing,
 * and "last played" is whichever is newer: that, or recently-played. An
 * optional cron trigger (every minute) keeps it fresh even when nobody is
 * visiting the site. Without the binding it behaves exactly as before.
 */

const DEFAULT_ORIGINS = "https://manishbazz.github.io,http://localhost:3000,http://127.0.0.1:3000";

export interface Env {
  ALLOWED_ORIGINS?: string;
  SETUP_MODE?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SPOTIFY_REFRESH_TOKEN?: string;
  LASTFM_USER?: string;
  LASTFM_API_KEY?: string;
  /** Optional KV namespace: remembers the last track seen playing. */
  LAST_SEEN?: KVNamespace;
}

export type NowPlaying = {
  isPlaying: boolean;
  title: string;
  artist: string;
  album?: string;
  albumArt?: string;
  songUrl?: string;
  progressMs?: number;
  durationMs?: number;
  /** ISO time the track was last played (when not playing). */
  playedAt?: string;
};

const SCOPES = "user-read-currently-playing user-read-recently-played";
const CACHE_SECONDS = 15;
const LAST_SEEN_KEY = "last-seen";
/** While the same track keeps playing, refresh its seenAt at most this often
 * (keeps KV writes well inside the free tier's 1000/day). */
const LAST_SEEN_REFRESH_MS = 10 * 60_000;

type Seen = Omit<NowPlaying, "isPlaying" | "progressMs" | "playedAt"> & { seenAt: string };

async function readSeen(env: Env): Promise<Seen | null> {
  if (!env.LAST_SEEN) return null;
  try {
    const raw = await env.LAST_SEEN.get(LAST_SEEN_KEY);
    return raw ? (JSON.parse(raw) as Seen) : null;
  } catch {
    return null;
  }
}

/** Record a track seen in currently-playing (only when it changed, or every
 * LAST_SEEN_REFRESH_MS while it's still playing). */
async function rememberSeen(env: Env, now: NowPlaying, prev: Seen | null): Promise<void> {
  if (!env.LAST_SEEN) return;
  const same = prev && prev.songUrl === now.songUrl && prev.title === now.title;
  if (same && Date.now() - Date.parse(prev.seenAt) < LAST_SEEN_REFRESH_MS) return;
  const seen: Seen = {
    title: now.title, artist: now.artist, album: now.album, albumArt: now.albumArt,
    songUrl: now.songUrl, durationMs: now.durationMs, seenAt: new Date().toISOString(),
  };
  try {
    await env.LAST_SEEN.put(LAST_SEEN_KEY, JSON.stringify(seen));
  } catch (err) {
    console.error("LAST_SEEN put failed", err);
  }
}

let accessToken: { value: string; expires: number } | null = null;

type SpotifyTrack = {
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string; width: number }[] };
  external_urls?: { spotify?: string };
  duration_ms: number;
};

function trackToJson(t: SpotifyTrack): Omit<NowPlaying, "isPlaying"> {
  const images = [...(t.album?.images ?? [])].sort((a, b) => a.width - b.width);
  // Smallest image >= 64 px wide: the widget shows a ~48 px thumbnail.
  const art = images.find((i) => i.width >= 64) ?? images[images.length - 1];
  return {
    title: t.name,
    artist: t.artists.map((a) => a.name).join(", "),
    album: t.album?.name,
    albumArt: art?.url,
    songUrl: t.external_urls?.spotify,
    durationMs: t.duration_ms,
  };
}

async function getAccessToken(env: Env): Promise<string> {
  if (accessToken && accessToken.expires > Date.now() + 30_000) return accessToken.value;
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET || !env.SPOTIFY_REFRESH_TOKEN) {
    throw new Error("Spotify secrets not set");
  }
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: env.SPOTIFY_REFRESH_TOKEN }),
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return accessToken.value;
}

async function fromSpotify(env: Env): Promise<NowPlaying | null> {
  const token = await getAccessToken(env);
  const headers = { Authorization: `Bearer ${token}` };

  const now = await fetch("https://api.spotify.com/v1/me/player/currently-playing", { headers });
  if (now.status === 200) {
    const data = (await now.json()) as {
      is_playing: boolean;
      progress_ms: number | null;
      currently_playing_type: string;
      item: SpotifyTrack | null;
    };
    // Podcasts/ads have no track item: fall through to "last played".
    if (data.item && data.currently_playing_type === "track") {
      const result = { isPlaying: data.is_playing, progressMs: data.progress_ms ?? undefined, ...trackToJson(data.item) };
      if (data.is_playing) await rememberSeen(env, result, await readSeen(env));
      return result;
    }
  } else if (now.status !== 204) {
    throw new Error(`currently-playing: ${now.status}`);
  }

  const recent = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=1", { headers });
  if (!recent.ok) throw new Error(`recently-played: ${recent.status}`);
  const r = (await recent.json()) as { items: { track: SpotifyTrack; played_at: string }[] };
  const last = r.items?.[0];
  const fromHistory: NowPlaying | null = last
    ? { isPlaying: false, playedAt: last.played_at, ...trackToJson(last.track) }
    : null;
  // Recently-played skips tracks that weren't played to the end; prefer the
  // last track we saw playing if it's newer.
  const seen = await readSeen(env);
  if (seen && (!fromHistory?.playedAt || Date.parse(seen.seenAt) > Date.parse(fromHistory.playedAt))) {
    const { seenAt, ...rest } = seen;
    return { isPlaying: false, playedAt: seenAt, ...rest };
  }
  return fromHistory;
}

async function fromLastfm(env: Env): Promise<NowPlaying | null> {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method: "user.getrecenttracks",
    user: env.LASTFM_USER!,
    api_key: env.LASTFM_API_KEY!,
    format: "json",
    limit: "1",
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`last.fm: ${res.status}`);
  const data = (await res.json()) as {
    recenttracks?: {
      track:
        | {
            name: string;
            artist: { "#text": string };
            album?: { "#text": string };
            image?: { "#text": string; size: string }[];
            url?: string;
            date?: { uts: string };
            "@attr"?: { nowplaying?: string };
          }[]
        | undefined;
    };
  };
  const t = data.recenttracks?.track?.[0];
  if (!t) return null;
  const art = t.image?.find((i) => i.size === "medium")?.["#text"] || undefined;
  return {
    isPlaying: t["@attr"]?.nowplaying === "true",
    title: t.name,
    artist: t.artist["#text"],
    album: t.album?.["#text"] || undefined,
    albumArt: art,
    songUrl: t.url,
    playedAt: t.date ? new Date(Number(t.date.uts) * 1000).toISOString() : undefined,
  };
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim());
  return allowed.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : { Vary: "Origin" };
}

function html(body: string, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:640px;margin:3rem auto;line-height:1.6">${body}`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function handleSetup(request: Request, env: Env, url: URL): Promise<Response> {
  if (env.SETUP_MODE !== "1") return new Response("Not found", { status: 404 });
  const redirectUri = `${url.origin}/callback`;
  if (url.pathname === "/login") {
    const auth = new URL("https://accounts.spotify.com/authorize");
    auth.search = new URLSearchParams({
      client_id: env.SPOTIFY_CLIENT_ID ?? "",
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
    }).toString();
    return Response.redirect(auth.toString(), 302);
  }
  const code = url.searchParams.get("code");
  if (!code) return html(`<p>Spotify returned: ${url.searchParams.get("error") ?? "no code"}</p>`, 400);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) return html(`<p>Token exchange failed (${res.status}): ${await res.text()}</p>`, 502);
  const data = (await res.json()) as { refresh_token: string };
  return html(`<h2>Spotify connected</h2>
<p>Save this refresh token as the worker secret <code>SPOTIFY_REFRESH_TOKEN</code>
(Cloudflare dashboard -> now-playing -> Settings -> Variables and secrets, or
<code>npx wrangler secret put SPOTIFY_REFRESH_TOKEN</code>), then set SETUP_MODE back to 0:</p>
<textarea id="rt" rows="4" style="width:100%" readonly>${data.refresh_token}</textarea>`);
}

export default {
  /** Optional cron trigger (e.g. every minute): polls Spotify so LAST_SEEN
   * catches songs even when nobody has the site open. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (!env.LAST_SEEN || (env.LASTFM_USER && env.LASTFM_API_KEY)) return;
    try {
      await fromSpotify(env);
    } catch (err) {
      console.error("scheduled poll failed", err);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/login" || url.pathname === "/callback") return handleSetup(request, env, url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...corsHeaders(request, env), "Access-Control-Allow-Methods": "GET" } });
    }
    if (url.pathname !== "/" || request.method !== "GET") return new Response("Not found", { status: 404 });

    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/", { method: "GET" });
    let body: string | null = null;
    const hit = await cache.match(cacheKey);
    if (hit) body = await hit.text();
    else {
      try {
        const useLastfm = Boolean(env.LASTFM_USER && env.LASTFM_API_KEY);
        const data = useLastfm ? await fromLastfm(env) : await fromSpotify(env);
        body = JSON.stringify(data ?? { isPlaying: false, title: "", artist: "" });
        ctx.waitUntil(
          cache.put(cacheKey, new Response(body, { headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` } })),
        );
      } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: "upstream unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders(request, env) },
        });
      }
    }
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
        ...corsHeaders(request, env),
      },
    });
  },
};

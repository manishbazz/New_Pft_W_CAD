// bun test — exercises the worker with mocked Spotify / Last.fm responses.
import { beforeEach, expect, test } from "bun:test";

const routes: Record<string, () => Response> = {};
let calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  calls.push(url);
  for (const [prefix, make] of Object.entries(routes)) if (url.startsWith(prefix)) return make();
  return new Response("unmocked " + url, { status: 500 });
}) as typeof fetch;
const store = new Map<string, string>();
(globalThis as unknown as { caches: unknown }).caches = {
  default: {
    match: async (r: Request) => (store.has(r.url) ? new Response(store.get(r.url)) : undefined),
    put: async (r: Request, res: Response) => void store.set(r.url, await res.text()),
  },
};
const ctx = { waitUntil: (p: Promise<unknown>) => p, passThroughOnException() {} } as unknown as ExecutionContext;

const track = {
  name: "Weightless",
  artists: [{ name: "Marconi Union" }],
  album: { name: "Weightless", images: [{ url: "big", width: 640 }, { url: "mid", width: 300 }, { url: "small", width: 64 }] },
  external_urls: { spotify: "https://open.spotify.com/track/x" },
  duration_ms: 480000,
};
const env = {
  ALLOWED_ORIGINS: "https://manishbazz.github.io",
  SPOTIFY_CLIENT_ID: "id",
  SPOTIFY_CLIENT_SECRET: "secret",
  SPOTIFY_REFRESH_TOKEN: "refresh",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const get = (origin = "https://manishbazz.github.io") =>
  new Request("https://now-playing.example.workers.dev/", { headers: { Origin: origin } });

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  store.clear();
  calls = [];
  routes["https://accounts.spotify.com/api/token"] = () => json({ access_token: "tok", expires_in: 3600 });
});

async function load() {
  return (await import("./index.ts?" + Math.random())).default;
}

test("playing track", async () => {
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () =>
    json({ is_playing: true, progress_ms: 61000, currently_playing_type: "track", item: track });
  const w = await load();
  const res = await w.fetch(get(), env, ctx);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://manishbazz.github.io");
  expect(await res.json()).toEqual({
    isPlaying: true, progressMs: 61000, title: "Weightless", artist: "Marconi Union", album: "Weightless",
    albumArt: "small", songUrl: "https://open.spotify.com/track/x", durationMs: 480000,
  });
});

test("nothing playing -> last played, and edge cache hit on 2nd request", async () => {
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () => new Response(null, { status: 204 });
  routes["https://api.spotify.com/v1/me/player/recently-played"] = () =>
    json({ items: [{ track, played_at: "2026-11-26T08:00:00Z" }] });
  const w = await load();
  const a = await (await w.fetch(get(), env, ctx)).json();
  expect(a.isPlaying).toBe(false);
  expect(a.playedAt).toBe("2026-11-26T08:00:00Z");
  const n = calls.length;
  await w.fetch(get(), env, ctx);
  expect(calls.length).toBe(n); // served from cache
});

test("podcast falls back to last played track", async () => {
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () =>
    json({ is_playing: true, progress_ms: 1, currently_playing_type: "episode", item: null });
  routes["https://api.spotify.com/v1/me/player/recently-played"] = () => json({ items: [{ track, played_at: "t" }] });
  const w = await load();
  expect((await (await w.fetch(get(), env, ctx)).json()).title).toBe("Weightless");
});

test("other origins get no CORS header; upstream error -> 502", async () => {
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () => new Response("", { status: 503 });
  const w = await load();
  const res = await w.fetch(get("https://evil.example"), env, ctx);
  expect(res.status).toBe(502);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("last.fm route", async () => {
  routes["https://ws.audioscrobbler.com/2.0/"] = () =>
    json({ recenttracks: { track: [{ name: "Song", artist: { "#text": "Band" }, album: { "#text": "LP" },
      image: [{ "#text": "s", size: "small" }, { "#text": "m", size: "medium" }], url: "https://last.fm/x",
      "@attr": { nowplaying: "true" } }] } });
  const w = await load();
  const r = await (await w.fetch(get(), { ALLOWED_ORIGINS: "x", LASTFM_USER: "manish", LASTFM_API_KEY: "k" }, ctx)).json();
  expect(r).toEqual({ isPlaying: true, title: "Song", artist: "Band", album: "LP", albumArt: "m", songUrl: "https://last.fm/x" });
});

test("setup pages are off unless SETUP_MODE=1", async () => {
  const w = await load();
  const res = await w.fetch(new Request("https://w.dev/login"), env, ctx);
  expect(res.status).toBe(404);
  const on = await w.fetch(new Request("https://w.dev/login"), { ...env, SETUP_MODE: "1" }, ctx);
  expect(on.status).toBe(302);
  expect(on.headers.get("Location")).toContain("redirect_uri=https%3A%2F%2Fw.dev%2Fcallback");
});

// --- LAST_SEEN: songs stopped midway never reach Spotify's recently-played ---
function kv() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) };
}
const jp = { ...track, name: "Japanese Song", external_urls: { spotify: "https://open.spotify.com/track/jp" } };

test("partly played song is remembered and beats an older recently-played entry", async () => {
  const LAST_SEEN = kv();
  const e = { ...env, LAST_SEEN } as unknown as typeof env;
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () =>
    json({ is_playing: true, progress_ms: 40000, currently_playing_type: "track", item: jp });
  const w = await load();
  expect((await (await w.fetch(get(), e, ctx)).json()).title).toBe("Japanese Song");
  expect(LAST_SEEN.m.size).toBe(1);

  // Stopped midway: nothing playing, and recently-played only has an older finished track.
  store.clear();
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () => new Response(null, { status: 204 });
  routes["https://api.spotify.com/v1/me/player/recently-played"] = () =>
    json({ items: [{ track, played_at: "2026-01-01T00:00:00.000Z" }] });
  const r = await (await w.fetch(get(), e, ctx)).json();
  expect(r.title).toBe("Japanese Song");
  expect(r.isPlaying).toBe(false);
  expect(typeof r.playedAt).toBe("string");
});

test("a newer recently-played entry beats the remembered one", async () => {
  const LAST_SEEN = kv();
  LAST_SEEN.m.set("last-seen", JSON.stringify({ title: "Japanese Song", artist: "A", songUrl: "u", seenAt: "2026-01-01T00:00:00.000Z" }));
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () => new Response(null, { status: 204 });
  routes["https://api.spotify.com/v1/me/player/recently-played"] = () =>
    json({ items: [{ track, played_at: "2026-06-01T00:00:00.000Z" }] });
  const w = await load();
  const r = await (await w.fetch(get(), { ...env, LAST_SEEN } as unknown as typeof env, ctx)).json();
  expect(r.title).toBe("Weightless");
});

test("same track still playing is not rewritten on every poll; cron records without visitors", async () => {
  const LAST_SEEN = kv();
  let puts = 0;
  const counting = { ...LAST_SEEN, put: async (k: string, v: string) => { puts++; await LAST_SEEN.put(k, v); } };
  const e = { ...env, LAST_SEEN: counting } as unknown as typeof env;
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () =>
    json({ is_playing: true, progress_ms: 1, currently_playing_type: "track", item: jp });
  const w = await load();
  await w.scheduled({} as ScheduledController, e);
  await w.scheduled({} as ScheduledController, e);
  await w.scheduled({} as ScheduledController, e);
  expect(puts).toBe(1);
  expect(JSON.parse(LAST_SEEN.m.get("last-seen")!).title).toBe("Japanese Song");
});

test("without the KV binding, behaviour is unchanged", async () => {
  routes["https://api.spotify.com/v1/me/player/currently-playing"] = () => new Response(null, { status: 204 });
  routes["https://api.spotify.com/v1/me/player/recently-played"] = () => json({ items: [{ track, played_at: "t" }] });
  const w = await load();
  expect((await (await w.fetch(get(), env, ctx)).json()).title).toBe("Weightless");
  await w.scheduled({} as ScheduledController, env); // no-op, must not throw
});

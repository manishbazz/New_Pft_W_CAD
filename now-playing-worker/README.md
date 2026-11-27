# Now-playing worker

A tiny Cloudflare Worker (free plan is plenty) that tells the portfolio what
you're listening to. The site is a static GitHub Pages export, so it can't
hold Spotify's client secret or your refresh token — they live here as
Cloudflare secrets, and the site only ever sees a small public JSON:

```json
{ "isPlaying": true, "title": "…", "artist": "…", "album": "…",
  "albumArt": "https://i.scdn.co/…", "songUrl": "https://open.spotify.com/track/…",
  "progressMs": 61000, "durationMs": 240000 }
```

When nothing is playing it returns the last played track with `isPlaying:
false` and `playedAt`. Responses are cached for 15 s at the edge.

Pick **one** data source:

| | Spotify API (option A) | Last.fm (option B) |
|---|---|---|
| Needs | Spotify **Premium** (required for Development Mode apps since Feb 2026) | Free Spotify + free Last.fm account |
| Progress bar | Yes | No |
| Delay | ~15 s | ~15–30 s (scrobble lag) |

## 0. Deploy the worker once

```bash
cd now-playing-worker
bun install            # or npm install
bunx wrangler login    # opens Cloudflare in the browser (free account)
bunx wrangler deploy
```

Note the URL it prints, e.g. `https://now-playing.<your-subdomain>.workers.dev`.

## Option A — Spotify API (Premium)

1. Go to <https://developer.spotify.com/dashboard> → **Create app**.
   - Redirect URI: `https://now-playing.<your-subdomain>.workers.dev/callback`
     (HTTPS, exactly as printed above).
   - API: tick **Web API**.
2. Copy the Client ID and Client Secret from the app's settings, then:
   ```bash
   bunx wrangler secret put SPOTIFY_CLIENT_ID
   bunx wrangler secret put SPOTIFY_CLIENT_SECRET
   ```
3. Get your refresh token:
   - In `wrangler.toml` set `SETUP_MODE = "1"`, run `bunx wrangler deploy`.
   - Open `https://now-playing.<your-subdomain>.workers.dev/login`, approve.
   - The page shows your refresh token. Run
     `bunx wrangler secret put SPOTIFY_REFRESH_TOKEN` and paste it.
   - Set `SETUP_MODE = "0"` again and `bunx wrangler deploy` (turns the
     login pages off).
4. Check: open the worker URL — you should see JSON with your track.

## Option B — Last.fm (free Spotify)

1. Create a Last.fm account, then Settings → Applications → **Spotify
   scrobbling** → Connect.
2. Get an API key at <https://www.last.fm/api/account/create>.
3. In `wrangler.toml` set `LASTFM_USER = "your-lastfm-username"`, then
   ```bash
   bunx wrangler secret put LASTFM_API_KEY
   bunx wrangler deploy
   ```

## Connect the site

In `content/site.yaml`:

```yaml
spotifyStatusUrl: https://now-playing.<your-subdomain>.workers.dev/
```

Commit and push; the About page shows the live card (album art, animated
bars and a progress bar while playing; "Last played · 2 h ago" otherwise).

## Live deployment

Deployed via the Cloudflare dashboard (no CLI) at
`https://now-playing.bazztv17.workers.dev/` (Spotify route). Variables:
`SPOTIFY_CLIENT_ID`, `SETUP_MODE=0`; secrets: `SPOTIFY_CLIENT_SECRET`,
`SPOTIFY_REFRESH_TOKEN`. `ALLOWED_ORIGINS` falls back to the default in the
code when unset.

**The Spotify refresh token expires after 180 days** (shown on the app's
Basic Information page). When the card stops updating: set `SETUP_MODE` to
`1`, open `/login`, approve, save the new token as `SPOTIFY_REFRESH_TOKEN`,
set `SETUP_MODE` back to `0`.

## Accurate "last played" (recommended)

Spotify's recently-played list only records tracks played **to the end**.
Stop or skip a song midway and it never shows up there, so the card falls
back to the last song you finished, which can be hours old. To fix that,
give the worker somewhere to remember the last track it saw playing:

1. Cloudflare dashboard → **Storage & Databases → KV → Create** a namespace
   (any name, e.g. `now-playing-last-seen`).
2. **Workers & Pages → now-playing → Settings → Bindings → Add → KV
   namespace**: variable name `LAST_SEEN`, pick the namespace above.
3. **Settings → Trigger events (Cron Triggers) → Add**: `* * * * *` (every
   minute), so songs are caught even when nobody has the site open.
4. Paste the current `src/index.ts` into the worker editor and **Deploy**.

KV writes happen only when the song changes (or every 10 min while the
same one plays), well inside the free tier. Without the binding the worker
behaves exactly as before.

With the CLI instead: uncomment the `kv_namespaces` and `triggers` blocks in
`wrangler.toml`, fill in the namespace id, `bunx wrangler deploy`.

## Notes

- `ALLOWED_ORIGINS` in `wrangler.toml` limits which sites may call the
  worker from a browser. Add your custom domain there if you get one.
- Tests (mocked Spotify/Last.fm): `bun test`. Type-check: `bun run typecheck`.
- Logs: `bunx wrangler tail`.

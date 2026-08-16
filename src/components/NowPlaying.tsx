"use client";

/**
 * Live Spotify "now playing" widget.
 *
 * IMPORTANT — why this needs an external endpoint:
 * This site is a static export on GitHub Pages, which can only serve files —
 * it can't run server code or hold secrets. Spotify's API requires an OAuth
 * client secret + refresh token to check what's playing, and those must
 * NEVER be shipped in client-side code (anyone could read them out of the
 * bundle and use them). So a live widget needs a small serverless proxy
 * hosted elsewhere (that's where the secrets live), which returns a small
 * public JSON blob this component polls.
 *
 * Recommended free path:
 *   1. Fork a ready-made proxy, e.g. github.com/kittinan/spotify-github-profile
 *      or github.com/novatorem/novatorem (spotify now-playing API route).
 *   2. Deploy it to Vercel's free tier (one click from the repo).
 *   3. Create a Spotify Developer app, get a refresh token for your account
 *      (the proxy's README walks through this), set it as an env var on
 *      Vercel — never in this repo.
 *   4. Set `spotifyStatusUrl` in content/site.yaml to your deployed
 *      endpoint's URL, e.g. https://your-proxy.vercel.app/api/now-playing
 *
 * Expected JSON response shape (matches the common community proxies above):
 *   { isPlaying: boolean, title: string, artist: string,
 *     albumArt?: string, songUrl?: string }
 *
 * Without spotifyStatusUrl set, this just shows the static `favoriteSong`
 * from site.yaml — still useful, just not "live".
 */

import { useEffect, useState } from "react";
import type { FavoriteSong } from "@/lib/types";

type NowPlayingProps = {
  statusUrl?: string;
  fallback?: FavoriteSong;
};

type LiveStatus = {
  isPlaying: boolean;
  title: string;
  artist: string;
  albumArt?: string;
  songUrl?: string;
};

const POLL_INTERVAL_MS = 30_000;

export function NowPlaying({ statusUrl, fallback }: NowPlayingProps) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!statusUrl) {
      setChecked(true);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(statusUrl, { cache: "no-store" });
        if (!res.ok) throw new Error("bad response");
        const data = (await res.json()) as LiveStatus;
        if (!cancelled) setLive(data);
      } catch {
        if (!cancelled) setLive(null);
      } finally {
        if (!cancelled) setChecked(true);
      }
    };

    poll();
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [statusUrl]);

  const isPlaying = Boolean(live?.isPlaying);
  const title = isPlaying ? live?.title : fallback?.title;
  const artist = isPlaying ? live?.artist : fallback?.artist;
  const url = isPlaying ? live?.songUrl : fallback?.url;

  if (!checked && statusUrl) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">
        <span className="size-2 animate-pulse rounded-full bg-[var(--muted)]" />
        Checking what's playing…
      </div>
    );
  }

  if (!title) return null;

  const content = (
    <div className="flex items-center gap-3 rounded-md border border-[var(--border)] px-4 py-3 transition-colors hover:border-[var(--accent)]">
      <span
        className={[
          "size-2 shrink-0 rounded-full",
          isPlaying ? "bg-[var(--accent)] dot-glow" : "bg-[var(--muted)]",
        ].join(" ")}
        aria-hidden
      />
      <div className="min-w-0 text-left">
        <p className="text-[10px] tracking-[0.2em] text-[var(--muted)] uppercase">
          {isPlaying ? "Now playing" : "Recent favorite"}
        </p>
        <p className="truncate text-sm text-[var(--text)]">{title}</p>
        <p className="truncate text-xs text-[var(--muted)]">{artist}</p>
      </div>
    </div>
  );

  if (!url) return content;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block">
      {content}
    </a>
  );
}

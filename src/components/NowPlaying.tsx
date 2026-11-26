"use client";

/**
 * Live Spotify "now playing" card.
 *
 * Data comes from the small Cloudflare Worker in /now-playing-worker (a
 * static GitHub Pages site can't hold Spotify's client secret / refresh
 * token, so they live in the Worker as secrets). Set its URL as
 * `spotifyStatusUrl` in content/site.yaml. Setup: now-playing-worker/README.md.
 *
 * Response shape:
 *   { isPlaying, title, artist, album?, albumArt?, songUrl?,
 *     progressMs?, durationMs?, playedAt? }
 *
 * Shows the current track with album art, animated bars and a progress
 * bar that advances locally between polls; when nothing is playing, the
 * last played track ("Last played · 2 h ago"). Polls every 30 s, only
 * while the tab is visible. Without spotifyStatusUrl, or if the endpoint
 * is down, falls back to the static `favoriteSong` in site.yaml.
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
  album?: string;
  albumArt?: string;
  songUrl?: string;
  progressMs?: number;
  durationMs?: number;
  playedAt?: string;
};

const POLL_INTERVAL_MS = 30_000;

function timeAgo(iso: string, now: number) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function Bars() {
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="eq-bar w-[3px] rounded-[1px] bg-[var(--accent)]"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

export function NowPlaying({ statusUrl, fallback }: NowPlayingProps) {
  const [live, setLive] = useState<(LiveStatus & { fetchedAt: number }) | null>(null);
  // With no status URL there's nothing to wait for.
  const [checked, setChecked] = useState(!statusUrl);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!statusUrl) return;
    let cancelled = false;
    let interval = 0;

    const poll = async () => {
      try {
        const res = await fetch(statusUrl, { cache: "no-store" });
        if (!res.ok) throw new Error("bad response");
        const data = (await res.json()) as LiveStatus;
        if (!cancelled) setLive(data.title ? { ...data, fetchedAt: Date.now() } : null);
      } catch {
        if (!cancelled) setLive(null);
      } finally {
        if (!cancelled) setChecked(true);
      }
    };
    const startPolling = () => {
      window.clearInterval(interval);
      poll();
      interval = window.setInterval(poll, POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) window.clearInterval(interval);
      else startPolling();
    };

    startPolling();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [statusUrl]);

  // Tick once a second while playing (progress bar), else once a minute
  // ("2 min ago").
  const isPlaying = Boolean(live?.isPlaying);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), isPlaying ? 1000 : 60_000);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  if (!checked && statusUrl) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">
        <span className="size-2 animate-pulse rounded-full bg-[var(--muted)]" />
        Checking what&apos;s playing…
      </div>
    );
  }

  const source = live ?? (fallback ? { ...fallback, songUrl: fallback.url } : null);
  if (!source?.title) return null;

  let label = "Recent favorite";
  if (live) label = isPlaying ? "Now playing on Spotify" : live.playedAt ? `Last played · ${timeAgo(live.playedAt, now)}` : "Last played";

  let progress: number | null = null;
  if (live && isPlaying && live.durationMs && live.progressMs != null) {
    const elapsed = live.progressMs + (now - live.fetchedAt);
    progress = Math.min(1, Math.max(0, elapsed / live.durationMs));
  }

  const content = (
    <div className="flex items-center gap-3 rounded-md border border-[var(--border)] px-3 py-3 transition-colors hover:border-[var(--accent)]">
      {live?.albumArt ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote Spotify CDN image on a static export
        <img
          src={live.albumArt}
          alt={live.album ? `Album art: ${live.album}` : ""}
          width={48}
          height={48}
          className="size-12 shrink-0 rounded-sm object-cover"
          loading="lazy"
        />
      ) : (
        <span
          className={["ml-1 size-2 shrink-0 rounded-full", isPlaying ? "bg-[var(--accent)] dot-glow" : "bg-[var(--muted)]"].join(" ")}
          aria-hidden
        />
      )}
      <div className="min-w-0 flex-1 text-left">
        <p className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-[var(--muted)] uppercase" aria-live="polite">
          {isPlaying && <Bars />}
          {label}
        </p>
        <p className="truncate text-sm text-[var(--text)]">{source.title}</p>
        <p className="truncate text-xs text-[var(--muted)]">{source.artist}</p>
        {progress != null && (
          <div className="mt-1.5 h-[2px] w-full overflow-hidden rounded bg-[var(--border)]" aria-hidden>
            <div className="h-full bg-[var(--accent)] transition-[width] duration-1000 ease-linear" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  );

  return source.songUrl ? (
    <a href={source.songUrl} target="_blank" rel="noopener noreferrer" className="block">
      {content}
    </a>
  ) : (
    content
  );
}

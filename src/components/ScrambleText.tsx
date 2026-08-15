"use client";

import { useEffect, useState } from "react";
import { playScrambleTick } from "@/lib/uiSound";

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";

type Tag = "h1" | "h2" | "h3" | "span" | "p";

type ScrambleTextProps = {
  text: string;
  className?: string;
  as?: Tag;
  /** Only scrambles while true; shows plain text otherwise. Re-triggers the
   * effect each time this flips from false to true (e.g. revisiting a tab). */
  play?: boolean;
  /** ms between the start of each successive character's reveal. */
  stagger?: number;
  /** ms a character spends scrambling before locking to its real value. */
  scrambleDuration?: number;
};

function randomChar(actual: string): string {
  if (actual === " ") return " ";
  return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
}

export function ScrambleText({
  text,
  className,
  as = "span",
  play = true,
  stagger = 45,
  scrambleDuration = 320,
}: ScrambleTextProps) {
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    if (!play) {
      setDisplay(text);
      return;
    }

    let cancelled = false;
    let rafId = 0;
    let start: number | null = null;
    const chars = text.split("");
    const locked = new Set<number>();

    const tick = (now: number) => {
      if (cancelled) return;
      if (start === null) start = now;
      const elapsed = now - start;

      let allDone = true;
      const next: string[] = [];

      chars.forEach((ch, i) => {
        if (ch === " ") {
          next.push(" ");
          return;
        }
        const revealAt = i * stagger;
        const lockAt = revealAt + scrambleDuration;

        if (elapsed >= lockAt) {
          next.push(ch);
          if (!locked.has(i)) {
            locked.add(i);
            playScrambleTick();
          }
        } else if (elapsed >= revealAt) {
          next.push(randomChar(ch));
          allDone = false;
        } else {
          next.push("");
          allDone = false;
        }
      });

      setDisplay(next.join(""));
      if (!allDone) rafId = requestAnimationFrame(tick);
    };

    setDisplay(chars.map((c) => (c === " " ? " " : "")).join(""));
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, text]);

  const Component = as;
  return <Component className={className}>{display}</Component>;
}

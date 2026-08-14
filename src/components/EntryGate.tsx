"use client";

import { useState } from "react";
import { HomeParticles } from "@/components/panels/HomeParticles";
import { playClickTick, unlockAudio } from "@/lib/uiSound";

type EntryGateProps = {
  children: React.ReactNode;
};

export function EntryGate({ children }: EntryGateProps) {
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);

  const handleEnter = () => {
    if (closing || entered) return;
    unlockAudio();
    playClickTick();
    setClosing(true);
    // Match the fade-out duration below.
    window.setTimeout(() => setEntered(true), 650);
  };

  return (
    <>
      {!entered && (
        <button
          type="button"
          onClick={handleEnter}
          aria-label="Click to enter"
          className={[
            "fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg)]",
            "transition-opacity duration-[650ms] ease-out",
            closing ? "pointer-events-none opacity-0" : "opacity-100",
          ].join(" ")}
        >
          <HomeParticles />
          <span className="relative animate-gate-pulse font-display text-sm tracking-[0.35em] text-[var(--muted-strong)] uppercase sm:text-base">
            Click to enter
          </span>
        </button>
      )}
      {entered && children}
    </>
  );
}

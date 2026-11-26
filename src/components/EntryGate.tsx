"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { HomeParticles } from "@/components/panels/HomeParticles";
import { playClickTick, unlockAudio } from "@/lib/uiSound";

type EntryGateProps = {
  children: React.ReactNode;
};

const EnteredContext = createContext(true);

/** True once the visitor has clicked through the entry gate. */
export function useEntered() {
  return useContext(EnteredContext);
}

const SESSION_KEY = "portfolio-entered";

/**
 * "Click to enter" splash (it also unlocks Web Audio, which browsers only
 * allow after a user gesture).
 *
 * The site itself is ALWAYS rendered underneath — the gate is just an
 * overlay. It used to render the children only after the click, which meant
 * the statically exported HTML contained nothing but "Click to enter": search
 * engines and LinkedIn/WhatsApp link previews saw an empty page. While the
 * gate is up the content is `inert` (not focusable, hidden from assistive
 * tech) and animations wait for `useEntered()`. Returning visitors in the
 * same browser session skip the gate.
 */
export function EntryGate({ children }: EntryGateProps) {
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(SESSION_KEY) === "1") {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only session flag
        setEntered(true);
      }
    } catch {
      /* storage blocked: just show the gate */
    }
  }, []);

  const handleEnter = () => {
    if (closing || entered) return;
    unlockAudio();
    playClickTick();
    setClosing(true);
    try {
      window.sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
    // Match the fade-out duration below.
    window.setTimeout(() => setEntered(true), 650);
  };

  return (
    <EnteredContext.Provider value={entered}>
      <div inert={!entered} className="contents">
        {children}
      </div>
      {!entered && (
        <button
          type="button"
          onClick={handleEnter}
          aria-label="Click to enter"
          className={[
            "fixed inset-0 z-[60] flex items-center justify-center bg-[var(--bg)]",
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
    </EnteredContext.Provider>
  );
}

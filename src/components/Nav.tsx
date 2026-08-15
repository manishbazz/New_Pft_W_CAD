"use client";

import { PANEL_IDS, PANEL_LABELS, type PanelId } from "@/lib/types";

type NavProps = {
  active: PanelId;
  onNavigate: (id: PanelId) => void;
};

export function Nav({ active, onNavigate }: NavProps) {
  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <nav
        className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-5"
        aria-label="Primary"
      >
        <button
          type="button"
          onClick={() => onNavigate("home")}
          className="font-display text-sm tracking-[0.2em] text-[var(--text)] uppercase transition-opacity hover:opacity-70"
        >
          Portfolio
        </button>
        <ul className="flex flex-wrap items-center justify-end gap-1 sm:gap-2">
          {PANEL_IDS.map((id) => {
            const isActive = id === active;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onNavigate(id)}
                  className={[
                    "font-display inline-block px-3 py-1.5 text-sm tracking-wide transition-colors",
                    isActive
                      ? "text-[var(--text)]"
                      : "text-[var(--muted)] hover:text-[var(--text)]",
                  ].join(" ")}
                  aria-current={isActive ? "page" : undefined}
                >
                  {PANEL_LABELS[id]}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}

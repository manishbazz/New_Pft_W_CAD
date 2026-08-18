"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { HomeConvectionBackground } from "@/components/HomeConvectionBackground";
import { Nav } from "@/components/Nav";
import { AboutPanel } from "@/components/panels/AboutPanel";
import { ContactPanel } from "@/components/panels/ContactPanel";
import { ExperiencePanel } from "@/components/panels/ExperiencePanel";
import { HomePanel } from "@/components/panels/HomePanel";
import { clampPanelIndex, isPanelId, panelIndex } from "@/lib/panels";
import { PANEL_IDS, type PanelId, type PortfolioContent } from "@/lib/types";

type ProjectsPanelProps = {
  projects: PortfolioContent["projects"];
  defaultModelUrl: string;
  active?: boolean;
};

type PortfolioAppProps = {
  content: PortfolioContent;
};

function readHashPanel(): PanelId {
  if (typeof window === "undefined") return "home";
  const hash = window.location.hash.replace(/^#/, "");
  return isPanelId(hash) ? hash : "home";
}

function findScrollableAncestor(
  start: EventTarget | null,
  root: HTMLElement | null,
): HTMLElement | null {
  let node =
    start instanceof Element
      ? start
      : start instanceof Node
        ? start.parentElement
        : null;

  while (node && node !== root) {
    if (node instanceof HTMLElement && node.dataset.panelScroll === "true") {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function canScroll(el: HTMLElement, deltaY: number): boolean {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 1) return false;
  if (deltaY < 0) return el.scrollTop > 0;
  return el.scrollTop < max - 1;
}

export function PortfolioApp({ content }: PortfolioAppProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [projectsMounted, setProjectsMounted] = useState(false);
  const [ProjectsPanel, setProjectsPanel] = useState<ComponentType<
    ProjectsPanelProps
  > | null>(null);
  const lockRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const wheelCarry = useRef(0);
  const activeIndexRef = useRef(0);

  const active = PANEL_IDS[activeIndex];

  // Unlock audio on the very first interaction anywhere on the page, so
  // hover sounds work right after that instead of only after whichever
  // element happens to be clicked first (browsers block audio until a
  // real user gesture has occurred).
  useEffect(() => {
    const unlock = () => {
      void import("@/lib/uiSound").then((mod) => mod.unlockAudio());
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    if (!projectsMounted || ProjectsPanel) return;
    let cancelled = false;
    import("@/components/panels/ProjectsPanel")
      .then((mod) => {
        if (!cancelled) setProjectsPanel(() => mod.ProjectsPanel);
      })
      .catch((err: unknown) => {
        console.error("[portfolio] failed to load ProjectsPanel", err);
      });
    return () => {
      cancelled = true;
    };
  }, [projectsMounted, ProjectsPanel]);

  const goToIndex = useCallback((index: number) => {
    const next = clampPanelIndex(index);
    const id = PANEL_IDS[next];

    activeIndexRef.current = next;
    setActiveIndex(next);
    if (id === "projects") setProjectsMounted(true);

    const nextHash = `#${id}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  }, []);

  const goToPanel = useCallback(
    (id: PanelId) => {
      goToIndex(panelIndex(id));
    },
    [goToIndex],
  );

  useEffect(() => {
    const fromHash = panelIndex(readHashPanel());
    activeIndexRef.current = fromHash;
    // Sync React state from the URL after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client hash bootstrap
    setActiveIndex(fromHash);
    if (PANEL_IDS[fromHash] === "projects") setProjectsMounted(true);

    const onHashChange = () => {
      const index = panelIndex(readHashPanel());
      activeIndexRef.current = index;
      setActiveIndex(index);
      if (PANEL_IDS[index] === "projects") setProjectsMounted(true);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const tryAdvance = useCallback(
    (deltaY: number, target: EventTarget | null) => {
      if (lockRef.current) return false;

      const scrollable = findScrollableAncestor(target, rootRef.current);
      if (scrollable && canScroll(scrollable, deltaY)) {
        wheelCarry.current = 0;
        return false;
      }

      wheelCarry.current += deltaY;
      if (Math.abs(wheelCarry.current) < 40) return false;

      const direction = wheelCarry.current > 0 ? 1 : -1;
      wheelCarry.current = 0;

      const next = activeIndexRef.current + direction;
      if (next < 0 || next >= PANEL_IDS.length) return false;

      lockRef.current = true;
      goToIndex(next);
      window.setTimeout(() => {
        lockRef.current = false;
      }, 700);
      return true;
    },
    [goToIndex],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        goToIndex(activeIndexRef.current + 1);
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goToIndex(activeIndexRef.current - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        goToIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        goToIndex(PANEL_IDS.length - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goToIndex]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onWheel = (event: WheelEvent) => {
      const scrollable = findScrollableAncestor(event.target, root);
      if (scrollable && canScroll(scrollable, event.deltaY)) {
        wheelCarry.current = 0;
        return;
      }

      event.preventDefault();
      tryAdvance(event.deltaY, event.target);
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [tryAdvance]);

  const panelWidthPercent = 100 / PANEL_IDS.length;

  return (
    <div
      ref={rootRef}
      className="relative h-dvh w-full overflow-hidden bg-[var(--bg)] text-[var(--text)]"
      data-active-panel={active}
      onTouchStart={(event) => {
        touchStartY.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(event) => {
        if (touchStartY.current == null) return;
        const endY = event.changedTouches[0]?.clientY;
        if (endY == null) return;
        const deltaY = touchStartY.current - endY;
        touchStartY.current = null;
        if (Math.abs(deltaY) < 48) return;
        wheelCarry.current = deltaY > 0 ? 40 : -40;
        tryAdvance(deltaY, event.target);
      }}
    >
      <Nav active={active} onNavigate={goToPanel} />

      {active === "home" && <HomeConvectionBackground />}

      <div className="h-full w-full overflow-hidden">
        <div
          className="flex h-full transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform"
          style={{
            width: `${PANEL_IDS.length * 100}%`,
            transform: `translate3d(-${activeIndex * panelWidthPercent}%, 0, 0)`,
          }}
        >
          <section
            data-panel="home"
            aria-label="Home"
            aria-hidden={active !== "home"}
            className="h-full shrink-0 overflow-hidden"
            style={{ width: `${panelWidthPercent}%` }}
          >
            <HomePanel site={content.site} active={active === "home"} />
          </section>

          <section
            data-panel="projects"
            aria-label="Projects"
            aria-hidden={active !== "projects"}
            className="h-full shrink-0 overflow-hidden"
            style={{ width: `${panelWidthPercent}%` }}
          >
            {ProjectsPanel ? (
              <ProjectsPanel
                projects={content.projects}
                defaultModelUrl={content.site.defaultModel}
                active={active === "projects"}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">
                {projectsMounted ? "Loading projects…" : "Projects"}
              </div>
            )}
          </section>

          <section
            data-panel="experience"
            aria-label="Experience"
            aria-hidden={active !== "experience"}
            className="h-full shrink-0 overflow-hidden"
            style={{ width: `${panelWidthPercent}%` }}
          >
            <ExperiencePanel
              experience={content.experience}
              active={active === "experience"}
            />
          </section>

          <section
            data-panel="about"
            aria-label="About"
            aria-hidden={active !== "about"}
            className="h-full shrink-0 overflow-hidden"
            style={{ width: `${panelWidthPercent}%` }}
          >
            <AboutPanel
              bio={content.site.bio ?? []}
              location={content.site.location}
              favoriteSong={content.site.favoriteSong}
              spotifyStatusUrl={content.site.spotifyStatusUrl}
              active={active === "about"}
            />
          </section>

          <section
            data-panel="contact"
            aria-label="Contact"
            aria-hidden={active !== "contact"}
            className="h-full shrink-0 overflow-hidden"
            style={{ width: `${panelWidthPercent}%` }}
          >
            <ContactPanel
              contactEmail={content.site.contactEmail}
              active={active === "contact"}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

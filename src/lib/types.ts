export type SocialLink = {
  label: string;
  href: string;
};

export type FavoriteSong = {
  title: string;
  artist: string;
  url?: string;
};

export type SiteContent = {
  name: string;
  designation: string;
  contactEmail: string;
  defaultModel: string;
  links: SocialLink[];
  location?: string;
  bio?: string[];
  favoriteSong?: FavoriteSong;
  /** Optional public JSON endpoint returning live Spotify now-playing status.
   * See NowPlaying.tsx for the expected response shape. Falls back to
   * favoriteSong (above) when unset or unreachable. */
  spotifyStatusUrl?: string;
};

export type ExperienceEntry = {
  id: string;
  role: string;
  company: string;
  location?: string;
  start: string;
  end: string;
  bullets: string[];
};

export type ProjectEntry = {
  id: string;
  title: string;
  summary: string;
  description: string;
  /** Public URL to GLB, if present */
  modelUrl?: string;
  /** Google Docs (or other) URL */
  docUrl?: string;
};

export type PortfolioContent = {
  site: SiteContent;
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
};

export const PANEL_IDS = [
  "home",
  "projects",
  "experience",
  "contact",
  "about",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const PANEL_LABELS: Record<PanelId, string> = {
  home: "Home",
  projects: "Projects",
  experience: "Experience",
  contact: "Contact",
  about: "About",
};

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type {
  ExperienceEntry,
  PortfolioContent,
  ProjectEntry,
  SiteContent,
} from "./types";

const contentRoot = path.join(process.cwd(), "content");
const publicRoot = path.join(process.cwd(), "public");

// Must match `basePath` in next.config.ts. Static export + GitHub Pages serves
// this site under a subpath, and libraries like drei's useGLTF fetch raw URLs
// directly (Next only auto-prefixes basePath for its own routing/<Image>).
const BASE_PATH = "/New_Pft_W_CAD";

function withBasePath(url: string): string {
  return `${BASE_PATH}${url}`;
}

function readYaml<T>(relativePath: string): T {
  const fullPath = path.join(contentRoot, relativePath);
  const raw = fs.readFileSync(fullPath, "utf8");
  return parse(raw) as T;
}

function normalizePublicPath(publicPath: string): string {
  return publicPath.startsWith("/") ? publicPath.slice(1) : publicPath;
}

/** Ensure a public URL exists, linking from the matching path under content/ if needed. */
function ensurePublicAsset(publicPath: string): boolean {
  const normalized = normalizePublicPath(publicPath);
  const pubFile = path.join(publicRoot, normalized);
  if (fs.existsSync(pubFile)) return true;

  const contentFile = path.join(contentRoot, normalized);
  if (!fs.existsSync(contentFile)) return false;

  fs.mkdirSync(path.dirname(pubFile), { recursive: true });
  try {
    fs.symlinkSync(
      path.relative(path.dirname(pubFile), contentFile),
      pubFile,
    );
  } catch {
    fs.copyFileSync(contentFile, pubFile);
  }
  return fs.existsSync(pubFile);
}

function resolveProjectModelUrl(
  projectId: string,
  modelFile: string | undefined,
): string | undefined {
  if (!modelFile) return undefined;
  const url = `/projects/${projectId}/${modelFile}`;
  return ensurePublicAsset(url) ? withBasePath(url) : undefined;
}

type SiteYaml = {
  name: string;
  designation: string;
  contactEmail: string;
  defaultModel: string;
  links: SiteContent["links"];
  location?: string;
  bio?: string[];
  favoriteSong?: SiteContent["favoriteSong"];
  spotifyStatusUrl?: string;
};

type ExperienceYaml = {
  experience: Omit<ExperienceEntry, "id">[] | ExperienceEntry[];
};

type ProjectsYaml = {
  projects: Record<
    string,
    {
      title: string;
      summary: string;
      description: string;
      model?: string;
      doc?: string;
    }
  >;
};

export function loadPortfolioContent(): PortfolioContent {
  const siteYaml = readYaml<SiteYaml>("site.yaml");
  const experienceYaml = readYaml<ExperienceYaml>("experience.yaml");
  const projectsYaml = readYaml<ProjectsYaml>("projects.yaml");

  const site: SiteContent = {
    name: siteYaml.name,
    designation: siteYaml.designation,
    contactEmail: siteYaml.contactEmail,
    defaultModel: ensurePublicAsset(siteYaml.defaultModel)
      ? withBasePath(siteYaml.defaultModel)
      : "",
    links: siteYaml.links ?? [],
    location: siteYaml.location,
    bio: siteYaml.bio ?? [],
    favoriteSong: siteYaml.favoriteSong,
    spotifyStatusUrl: siteYaml.spotifyStatusUrl,
  };

  const experience: ExperienceEntry[] = (experienceYaml.experience ?? []).map(
    (entry, index) => ({
      id: "id" in entry && entry.id ? entry.id : `exp-${index}`,
      role: entry.role,
      company: entry.company,
      location: entry.location,
      start: entry.start,
      end: entry.end,
      bullets: entry.bullets ?? [],
    }),
  );

  const projects: ProjectEntry[] = Object.entries(
    projectsYaml.projects ?? {},
  ).map(([id, project]) => ({
    id,
    title: project.title,
    summary: project.summary,
    description: project.description.trim(),
    modelUrl: resolveProjectModelUrl(id, project.model),
    docUrl: project.doc,
  }));

  return { site, experience, projects };
}

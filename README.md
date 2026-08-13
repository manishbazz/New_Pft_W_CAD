# Manish Portfolio

Dark, minimal project showcase built with **Next.js**, **Bun**, and a **Nix flake**.

## Setup

```bash
nix develop
bun install
bun run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

`bun run dev` runs the Next.js server with **Node** (not Bun’s runtime). Bun is still used as the package manager. This avoids broken HMR WebSockets that prevent React from hydrating in the browser.


## Content

Edit YAML under `content/`:

- `site.yaml` — name, designation, social links, contact email, default model path
- `projects.yaml` — project metadata (`model` filename, `doc` Google Docs URL)
- `experience.yaml` — timeline entries

Project GLBs are served from `public/projects/<id>/<file>` (match the `model` field in YAML). Site default model: `public/models/default.glb`.

Until a GLB is present, the 3D pane shows a placeholder mesh.

## Navigation

Horizontal panels: Home → Projects → Experience → Contact.

- Scroll / trackpad moves between panels (inner lists scroll first)
- Navbar jumps to a panel
- Arrow keys / PageUp / PageDown also move between panels

Projects (desktop): list + right preview (Description / 3D / Doc). Mobile hides 3D.

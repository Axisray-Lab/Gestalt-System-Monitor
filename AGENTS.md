# Repository guidance

Gestalt-System-Monitor is a **public** repository: a passive LAN match monitor
(Vue 3 + Three.js SPA + a Node discovery agent) for **Gestalt System** matches.

## Confidentiality (important)

This repo is public; the game it monitors is a separate, private project. Keep all
contributions to the **player-observable wire contract** only:

- **OK to reference:** the LAN beacon format, ports, the JSON-RPC envelope, the
  `monitor.*` / `externalAim.*` / `lobby.*` method names, and the coordinate
  mapping — see [`packages/protocol`](packages/protocol) and
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- **Do NOT introduce** references to the game's internal source paths, internal
  class names, private repository hosts, or internal architecture/roadmap. Use the
  name **"Gestalt System"** for the game.

## Layout

- `packages/protocol` — shared wire types/constants (single source of truth).
- `packages/agent` — Node LAN discovery agent (`--mock` synthesizes a fake LAN).
- `packages/web` — Vite + Vue 3 + Three.js SPA.

## Working agreements

- Verify with `npm run typecheck` (and `npm run test` once a runner is added).
- Keep changes small and reviewable; a human reviews and merges every PR — CI
  passing is necessary, not sufficient.
- See [`docs/ROADMAP.md`](docs/ROADMAP.md) for versions and milestones.

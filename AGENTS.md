# Repository guidance

Gestalt-System-Monitor is a **public** repository: a passive LAN match monitor
(Vue 3 + Three.js SPA + a Node discovery agent) for **Gestalt System** matches.

## Confidentiality (important)

This repo is **public**; the game it monitors is a separate, private project. Keep
contributions to what this product needs to run on its own (it stays self-contained),
plus the **player-observable wire contract** — the LAN beacon, ports, the JSON-RPC
envelope, the `monitor.*` / `externalAim.*` / `lobby.*` method names, and the
coordinate mapping (see [`packages/protocol`](packages/protocol) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). Anything internal to the private
project stays out. Use the name **"Gestalt System"** for the game; when unsure, ask
before committing.

## Layout

- `packages/protocol` — shared wire types/constants (single source of truth).
- `packages/agent` — Node LAN discovery agent (`--mock` synthesizes a fake LAN).
- `packages/web` — Vite + Vue 3 + Three.js SPA.
- `packages/desktop` — Tauri bottom-edge AppBar dock; loads the deck UI and auto-spawns the agent. See `docs/DESKTOP.md`.

## Working agreements

- Verify with `npm run typecheck` (and `npm run test` once a runner is added).
- Keep changes small and reviewable; a human reviews and merges every PR — CI
  passing is necessary, not sufficient.
- See [`docs/ROADMAP.md`](docs/ROADMAP.md) for versions and milestones.

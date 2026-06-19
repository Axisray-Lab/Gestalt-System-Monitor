# Roadmap

How **Gestalt-System-Monitor** grows from a passive match viewer into a release
companion for **Gestalt System**, and then into the front-end for an external-AI
robot arena.

Two tracks run in parallel:

- **Monitor track** (this repo, public) — the SPA + discovery agent + wire protocol.
- **Game-side capabilities** (tracked separately) — support the game must expose,
  described here only at the **wire / feature** level (what's observable to any
  client). Implementation lives with the game.

A monitor version ships only when its game-side dependency is available and the two
have been integration-tested together.

---

## Release plan — ships with Gestalt System **0.1.9-AI**

The first public release is a **spectator + launcher**: watch real AI-vs-AI matches
and start them. Determinism, fairness and untrusted-code execution are deliberately
**not** in this scope — they belong to the external-AI arena (0.2.0) where they
actually matter.

| Version | Theme | Game-side dependency | Status |
|---|---|---|---|
| **v0.1** | **Live watch loop** — render real matches, not just the mock | GS-1 Live telemetry & auto-discovery | ▶ active |
| **v0.2** | **Launch & control** — discover the install + start headless AI-vs-AI from the monitor | GS-2 Headless match launch | monitor-side active |
| **v0.3** | **Spectator polish** — multi-match overview, per-unit info, basic post-match summary | (AI gameplay quality, part of 0.1.9-AI) | planned |
| **v1.0** | **Release** — the above, hardened + documented, shipped with 0.1.9-AI | GS-1 + GS-2 | target |

### v0.1 — Live watch loop ▶
Consume live telemetry by subscribing to the game's existing
`attribute.watchAttributeMaps` channel (the same one the in-game HUD uses);
auto-discover real match processes via the LAN beacon; graceful "no live match"
state; keep the mock as a demo. The arena is placed client-side from the beacon's
`mapId`, so no map-geometry push is required.
**GS-1:** boot-time beacon carrying the WebSocket port + match id; and per-robot
**position + chassis/turret heading** written into the attribute map (health / team
/ player-id are already streamed there).
(Wire contract: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).)

### v0.2 — Launch & control
The agent (the privileged local process) discovers the installed game, reports
CPU/RAM headroom, and launches headless AI-vs-AI matches through a configured
entrypoint; the SPA drives it and auto-attaches to the result.
**GS-2:** a packaged / scriptable headless entrypoint that boots an AI-vs-AI match
and (via GS-1) advertises + streams it.

### v0.3 — Spectator polish
Several matches as small dioramas in one scene, a clean per-unit info panel, and a
lightweight end-of-match summary over the existing telemetry. No new game-side
dependency beyond gameplay quality already landing in 0.1.9-AI.

Scope refined in **[DASHBOARD_PLAN.md](DASHBOARD_PLAN.md)** (2026-06-19):
- Unit info cards (HP / ammo / damage / AIMoveMode / buffs)
- Supply reload effectiveness indicator
- Movement trajectory trails + heatmap overlay
- Contribution ranking table (per-match + cross-match)
- Dart state machine panel
- Multi-match overview with real-time score strips

### v1.0 — Release
v0.1–v0.3 hardened, with docs and an end-to-end acceptance pass against a real
0.1.9-AI build. This is the version that ships alongside the game.

---

## Reserved — **0.2.0: External-AI arena** (the more important one)

After release, the headless backend gains the ability to act as a **simulation
environment for real autonomous robot code**: it exposes a **video stream** and a
**LiDAR / point-cloud feed** as a robot's sensor input, plus a **control ingress**
for an external program to drive a robot. Competition teams plug in their *actual*
perception + control stacks and pit robots against each other.

| Version | Theme | Game-side dependency | Status |
|---|---|---|---|
| **v2.0** | **External-AI arena front-end** — host / spectate real-robot-code matches; the connect harness for teams | 0.2.0 video + point-cloud feeds + control ingress | reserved |

This milestone owns the genuinely hard problems that the spectator release avoids:
per-tick sensor streaming at usable latency/bandwidth, a stable perception+action
wire protocol, multi-robot fairness, **match reproducibility**, and **safe
execution / isolation of untrusted external code**. It warrants a dedicated
feasibility study before its sub-tasks are broken out (there is existing
external-control + frame-capture scaffolding to build on).

---

## Optional side-track — LLM-assisted strategy authoring

A lower-priority, casual on-ramp (distinct from the competitive 0.2.0 path):
natural-language intent compiles into an **inspectable, editable** strategy artifact
(schema-validated data, brokered through the agent so an API key never lives in
browser JS). Kept exploratory; the real-robot-code arena is the priority.

---

## How we work

- **Roadmap → Milestones (versions) → Feature requests (issues) → PRs → review → release.**
- Feature requests are **small and self-contained**, each with: **Background ·
  Acceptance criteria (checkable) · Verification command · Out of scope.** Low
  granularity keeps each unit easy to implement, review, and automate.
- A change ships behind **CI green + acceptance met**, **merged by a human** after
  review — CI passing is necessary, not sufficient.
- Dependencies are gated: a feature request is only dispatched once its prerequisite
  has merged. A monitor version is "done" only after **integration testing** against
  the real game build.

# Team Builder — custom-match roster (wire contract)

Lets the SPA author a custom AI-vs-AI match (per-team roster + per-slot construct
and settings) and launch it through the agent. This doc covers only the
**player-observable launch interface**; cost/scoring and any game-internal balance
are **supplied at runtime** (see "Cost & scoring" below) and are not part of this
repo.

> Status: contract scaffold. Types live in `packages/protocol/src/team.ts`. The
> SPA can build the UI against them now (style-first); the launch wiring and the
> runtime cost config land alongside the game-side support.

## Flow

```
[web : TeamBuilder view]
  pick map → pick slot (career fixed by slot) → pick construct → tune settings
  show team cost (from runtime cost config; UI-side only)  → "Launch with this team"
        │ HeadlessMatchConfig
        ▼  POST /launch  { match }
[agent : LaunchManager]
  writes the roster to a temp file and launches one headless match using the
  CONFIGURED launch arg shape (the same configurable mechanism as `--headless-args`;
  no game-specific flag names are baked into this repo)
        ▼
[match] advertises the LAN beacon → the SPA auto-discovers and spectates it
        (same attribute stream as any other watched match)
```

## Types (`@gsm/protocol`)

- `RosterSlotConfig` — one slot: `teamNumber`, fixed `careerId`, chosen
  `entityType` (construct), a sparse `paramOverrides` map (attributeId → value),
  and optional per-slot settings the slot exposes.
- `TeamConfig` — `{ teamId, slots }`.
- `HeadlessMatchConfig` — `{ mapId, nettype, teams[], aiFill, attrrecord? }`.
- `LaunchHeadlessRequest.match?` — carries a `HeadlessMatchConfig`; when present the
  agent launches exactly one match with it.

The roster crosses the wire as an autostart parameter (a temp-file path), so it is
not size-limited by OS command-line limits.

## Cost & scoring

R&D「费」(cost) is a **monitor-side visualization metric only** — it compares the
two teams' build strength and is **never sent into / read by the game**. The model
lives in `packages/protocol/src/cost.ts`: `ENTITY_CATALOG` (career → constructs),
the per-axis `COST` formulas, `computeSlotCost` / `computeTeamCost`, and self-check
anchors (`RMUC2026_SAMPLE`). Raw 费 are summed directly (no 0-100 scale).

## Building the UI style-first

1. Import the types + cost helpers from `@gsm/protocol`.
2. `constructsForCareer(careerId)` drives each slot's construct dropdown.
3. `computeTeamCost(team)` drives the per-team cost badge + side-by-side compare.
4. `RMUC2026_SAMPLE` is the calibration reference while iterating.

# Team Builder — custom-match roster (wire contract)

Lets the SPA author a custom AI-vs-AI match (per-team roster + per-slot construct
and settings) and launch it through the agent. This doc covers only the
**player-observable launch interface**; cost/scoring and any game-internal balance
are **supplied at runtime** (see "Cost & scoring" below) and are not part of this
repo.

> Status: implemented on the Monitor side. The SPA edits the roster, posts
> `LaunchHeadlessRequest.match`, and the agent launches one headless match with
> the compact `-roster=` autostart payload.

## Flow

```
[web : TeamBuilder view]
  pick map → pick slot (career fixed by slot) → pick construct → tune settings
  show team cost (from runtime cost config; UI-side only)  → "Launch with this team"
        │ HeadlessMatchConfig
        ▼  POST /launch  { match }
[agent : LaunchManager]
  normalizes the request to a single local launch, folds the match into the
  configured UE / standalone profile, and appends the compact roster parameter
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

The roster crosses the wire as a compact autostart parameter:

```text
-roster="team,teamNumber,entityType[,attrId=value|attrId=value];..."
```

Example:

```text
0,1,66000001;0,3,66000002,60000021=140|10000031=1200
```

`packages/protocol/src/team.ts` owns `buildRosterSpec()` so the SPA and agent never
hand-roll this string independently.

## Cost & scoring

R&D「费」(cost) is a **monitor-side visualization metric only** — it compares the
two teams' build strength and is **never sent into / read by the game**. The model
lives in `packages/protocol/src/cost.ts`: `ENTITY_CATALOG` (career → constructs),
the per-axis `COST` formulas, `computeSlotCost` / `computeTeamCost`, and self-check
anchors (`RMUC2026_SAMPLE`). Raw 费 are summed directly (no 0-100 scale).

## UI entry points

- `RuleSet` / `RULESETS` seed RMUC, RMUL, and 1v1 rosters.
- `constructsForCareer(careerId)` drives each slot's construct dropdown.
- `computeSlotCost()` / `computeTeamCost()` drive the cost badges.
- `buildRosterSpec(match)` is displayed in the footer and sent by the agent.

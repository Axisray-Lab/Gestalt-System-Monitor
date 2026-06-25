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

- `RosterSlotConfig` — one slot: `teamNumber`, fixed `careerId`, chosen `entityType`
  (construct), and a sparse `tuning: SlotTuning` (any unset axis = the construct
  default).
- `SlotTuning` — the research surface: `discharge / ammo17 / ammo42 / fireRateHz /
  spreadMax / spreadMin / speedSpread`, plus structured `dart / engineer / radar`.
- `TeamConfig` — `{ teamId, slots }`; `HeadlessMatchConfig` — `{ mapId, nettype,
  teams[], aiFill, attrrecord? }`.
- `LaunchHeadlessRequest.match?` — carries a `HeadlessMatchConfig`; the roster
  crosses the wire as an autostart parameter (a temp-file path), so it is not
  size-limited by OS command-line limits.

### Data the UI drives from

- **`roster.ts`** — `RuleSet`, `RULESETS[ruleSet]` (slot layout per 赛制),
  `buildDefaultRoster(ruleSet, teamId)`, and `CAREER_RULES` (read-only HP / 底盘功率 /
  热容 / 散热 / 电容 for the info panel).
- **`cost.ts`** — `ENTITY_CATALOG`, `constructsForCareer(careerId)`,
  `CONSTRUCT_DEFAULTS`, `computeSlotCost` / `computeTeamCost`.
- **`params.ts`** — `TUNABLE_PARAMS` + `paramsForConstruct(entityType)` (slider
  specs), `defaultsForConstruct`, `hasDart/hasEngineer/hasRadar`, and the option
  sets `ENGINEER_ASSEMBLY_LEVELS / ENGINEER_CORE_POOLS / DART_BASE_MODES /
  RADAR_DETECTION_MODES`.

## Cost & scoring

R&D「费」(cost) is a **monitor-side visualization metric only** — it compares the
two teams' build strength and is **never sent into / read by the game**. The model
lives in `packages/protocol/src/cost.ts`: `ENTITY_CATALOG` (career → constructs),
the per-axis `COST` formulas, `computeSlotCost` / `computeTeamCost`, and self-check
anchors (`RMUC2026_SAMPLE`). Raw 费 are summed directly (no 0-100 scale).

## Building the UI style-first

1. Pick a `RuleSet` → `RULESETS[ruleSet].slots` lays out the team; seed each team
   with `buildDefaultRoster(ruleSet, teamId)`.
2. Per slot: `constructsForCareer(slot.careerId)` fills the construct dropdown;
   `paramsForConstruct(entityType)` gives the sliders, `defaultsForConstruct` seeds
   them, and `hasDart/hasEngineer/hasRadar` gate the structured controls.
3. `computeSlotCost(slot)` / `computeTeamCost(team)` drive the cost badges +
   side-by-side compare; `CAREER_RULES[careerId]` fills the read-only stat panel.
4. `RMUC2026_SAMPLE` (ranged 79.0 / melee 86.7) is the calibration reference — a
   default RMUC2026 roster should reproduce it.

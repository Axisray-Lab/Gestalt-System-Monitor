# Team Builder — custom-match roster

Lets the SPA author a custom AI-vs-AI match (per-team roster + per-slot construct
and settings) and launch it through the agent.

- **Wire contract** (the launch payload) lives in `packages/protocol/src/team.ts`.
- **Domain + UI logic** (catalog, R&D 费 cost, 赛制 templates, slider specs, state)
  lives in `packages/web/src/teambuilder/` — it is monitor-side only and never
  crosses the wire / is never read by the game.

> Status: scaffold. The SPA can build the UI against it now (style-first). The
> launch wiring is a TARGET CONTRACT — the agent does not yet forward
> `LaunchHeadlessRequest.match`, and the game's `-roster` parse is pending
> (game-side support, tracked separately).

## Flow

```
[web : TeamBuilder view (useTeamBuilder)]
  pick 赛制 → pick slot (career fixed) → pick construct → tune → live 费
        │ HeadlessMatchConfig                                   → "Launch with this team"
        ▼  POST /launch  { match }
[agent : LaunchManager]   (TARGET) writes the roster to a temp file and launches one
  headless match via the CONFIGURED launch arg shape (same mechanism as
  --headless-args; no game-specific flag names baked into this public repo)
        ▼
[match] advertises the LAN beacon → the SPA auto-discovers and spectates it
```

## Wire contract (`packages/protocol/src/team.ts`)

- `RosterSlotConfig` — one slot: `teamNumber`, fixed `careerId`, chosen `entityType`,
  and a sparse `tuning: SlotTuning` (any unset axis = the construct default). Carries
  a SEAM comment where the **Coach / Unit-Strategy agent** adds AI move/target/fire
  modes.
- `SlotTuning` — the research surface: `discharge / ammo17 / ammo42 / fireRateHz /
  spreadMax / spreadMin / speedSpread`, plus structured `dart / engineer / radar`.
- `TeamConfig` `{ teamId, slots }`; `HeadlessMatchConfig` `{ mapId, nettype, teams[],
  aiFill, attrrecord? }`; `LaunchHeadlessRequest.match?`.

## Domain + UI (`packages/web/src/teambuilder/`)

- **`roster.ts`** — `RuleSet`, `RULESETS[ruleSet]` (slot layout per 赛制),
  `CAREER_RULES` (read-only HP/底盘功率/热容/散热/电容 panel), and the **example**
  lineups: `buildExampleRoster(ruleSet, teamId)`, `exampleMatch(ruleSet)`,
  `EXAMPLE_LABEL`. These are *editable starting templates the player copies* — NOT
  the game's immutable internal default roster; hence the `example*` naming.
- **`cost.ts`** — `ENTITY_CATALOG`, `constructsForCareer`, `CONSTRUCT_DEFAULTS`,
  `computeSlotCost` / `computeTeamCost`, `RMUC2026_SAMPLE` (ranged 79.0 / melee 86.7).
- **`params.ts`** — `TUNABLE_PARAMS` + `paramsForConstruct` (slider specs),
  `defaultsForConstruct`, `hasDart/hasEngineer/hasRadar`, and the option sets
  `ENGINEER_ASSEMBLY_LEVELS / ENGINEER_CORE_POOLS / DART_BASE_MODES /
  RADAR_DETECTION_MODES`.
- **`useTeamBuilder.ts`** — the state composable: holds two editable teams seeded
  from the example lineup, `setConstruct` / `setTuning` / `loadExample`, and live
  `teamCosts` / `costDelta`.

## Building the UI style-first

```ts
import { useTeamBuilder } from '@/teambuilder/useTeamBuilder';
import { constructsForCareer } from '@/teambuilder/cost';
import { paramsForConstruct, hasDart, DART_BASE_MODES } from '@/teambuilder/params';
import { RuleSet, EXAMPLE_LABEL, CAREER_RULES } from '@/teambuilder/roster';

const tb = useTeamBuilder(RuleSet.RMUC2026); // tb.match seeded from the example lineup
```

1. `tb.match.teams` lays out red/blue; each `slot.careerId` is fixed.
2. Per slot: `constructsForCareer(slot.careerId)` → construct dropdown (`tb.setConstruct`);
   `paramsForConstruct(slot.entityType)` → sliders (`tb.setTuning`); `hasDart/…` gate the
   structured controls; `CAREER_RULES[slot.careerId]` → read-only stat panel.
3. `tb.teamCosts` / `tb.costDelta` drive the cost badges + side-by-side compare.
4. `RMUC2026_SAMPLE` is the calibration reference — the example RMUC2026 lineup
   reproduces it (red 79.0 / blue 86.7).

R&D「费」is display-only and never sent into / read by the game.

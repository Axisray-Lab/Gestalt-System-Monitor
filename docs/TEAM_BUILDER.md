# Team Builder — custom-match roster (wire contract)

Lets the SPA author a custom AI-vs-AI match (per-team roster + per-slot construct
and settings) and launch it through the agent. This document covers the
player-observable launch interface. Cost is a Monitor-side visualization and is
never sent to or read by the game.

> Status: implemented on the Monitor side. The SPA edits the roster, posts
> `LaunchHeadlessRequest.match`, and the agent launches one headless match with
> the compact `-roster=` autostart payload.

## Flow

```text
[web: Team Builder]
  pick rule set → pick slot → pick construct → tune settings → show team cost
        │ HeadlessMatchConfig
        ▼  POST /launch { match }
[agent: LaunchManager]
  normalizes the request to one local launch, applies the selected launch profile,
  and appends the compact roster parameter
        ▼
[match]
  advertises its LAN beacon → the SPA auto-discovers and spectates it
```

## Wire contract (`packages/protocol/src/team.ts`)

- `RuleSet` / `RULESETS` provide RMUC, RMUL, and 1v1 slot templates.
- `RosterSlotConfig` contains `teamNumber`, fixed `careerId`, selected
  `entityType`, sparse `paramOverrides`, and optional firing, spread, dart,
  engineer, and radar settings.
- `TeamConfig` contains `{ teamId, slots }`; optional `teamCost` is UI-only.
- `HeadlessMatchConfig` contains `{ mapId, nettype, teams, attrrecord?,
  attrrecordHz?, hudHidden? }`.
- `LaunchHeadlessRequest.match?` carries the match config to the local agent.

The roster crosses the process boundary as a compact autostart parameter:

```text
-roster="team,teamNumber,entityType[,attrId=value|attrId=value];..."
```

Example:

```text
0,1,66000001;0,3,66000002,60000021=140|10000031=1200
```

`buildRosterSpec()` owns this serialization so the SPA and agent do not hand-roll
the string independently. `slotAttrPairs()` is the single conversion from the
typed slot settings to player-observable attribute/value pairs.

## Cost and UI

`packages/protocol/src/cost.ts` contains the current shared Monitor cost model:

- `ENTITY_CATALOG` and `constructsForCareer()` drive construct selection;
- `CONSTRUCT_DEFAULTS` describes default tunings;
- `computeSlotCost()` / `computeTeamCost()` drive cost badges;
- `RMUC2026_SAMPLE` supplies calibration anchors.

The integrated editor lives in `packages/web/src/DeckApp.vue`; the reusable panel
is `packages/web/src/components/TeamBuilderPanel.vue`. Both consume the shared
protocol and cost exports from `@gsm/protocol`.

R&D cost and the optional `slotCost` / `teamCost` fields are display-only. The
game receives only the roster and attribute overrides produced by
`buildRosterSpec()`.

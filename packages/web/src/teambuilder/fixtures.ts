/**
 * Cost self-test fixture — a reference the team-builder UI can diff against.
 *
 * RED  = the RMUC2026 example lineup (team 0), unchanged.
 * BLUE = the example (team 1) with a deliberately-different custom override:
 *   construct swap + a max combat upgrade + economy/dart downgrades — exercises the
 *   build-tier, discharge / ammo17 / fireRate, dart and engineer cost axes.
 *
 * Expected values are produced by ./cost (computeSlotCost / computeTeamCost). If the
 * UI reproduces a different number for the same config, the UI diverged; if these
 * change on purpose, the cost model changed — update both together.
 */
import type { TeamConfig } from '@gsm/protocol';
import { RuleSet, buildExampleRoster, exampleMatch } from './roster';

export const SELFTEST_RULESET = RuleSet.RMUC2026;

/** RED = the example lineup (team 0), unchanged. */
export const redExampleTeam = (): TeamConfig => exampleMatch(SELFTEST_RULESET).teams[0]!;

/** BLUE = the example (team 1) with the custom overrides applied. */
export function customBlueTeam(): TeamConfig {
  const slots = buildExampleRoster(SELFTEST_RULESET, 1);
  const at = (tn: number) => slots.find((s) => s.teamNumber === tn)!;
  at(1).entityType = 66000003; // Hero: LUIGI → MOON-ROVER (construct swap, 命中率 TBD → 0)
  at(2).tuning = { engineer: { maxAssemblyLevel: 2, corePool: 4 } }; // Engineer: economy downgrade
  at(3).tuning = { discharge: 300, ammo17: 2000, fireRateHz: 30 }; // Infantry ACHILLES: max combat
  at(6).tuning = { dart: { canOutpost: true, canBase: false, maxBaseMode: 0 } }; // Drone dart: outpost-only
  return { teamId: 1, slots };
}

/** Expected costs (from ./cost) for the configs above. */
export const SELFTEST_EXPECTED = {
  redTotal: 79.02,
  blueTotal: 77.32,
  delta: 1.7,
  blueSlotCost: { 1: 11, 2: 2, 3: 18.33, 4: 12.33, 6: 21.33, 7: 12.33 } as Record<number, number>,
} as const;

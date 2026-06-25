/**
 * Team-builder state composable — holds the two editable teams (seeded from the
 * EXAMPLE lineup) and exposes live per-team 费. Mirrors the feed/discovery
 * composable pattern. The .vue view binds to this and owns presentation only.
 */
import { computed, reactive, ref } from 'vue';
import type { RosterSlotConfig, SlotTuning } from '@gsm/protocol';
import { computeSlotCost, computeTeamCost } from './cost';
import { RuleSet, exampleMatch } from './roster';

export function useTeamBuilder(initialRuleSet: RuleSet = RuleSet.RMUC2026) {
  const ruleSet = ref<RuleSet>(initialRuleSet);
  // Editable starting template (a COPY of the example lineup; not the game default).
  const match = reactive(exampleMatch(initialRuleSet));

  const findSlot = (teamId: number, teamNumber: number): RosterSlotConfig | undefined =>
    match.teams.find((t) => t.teamId === teamId)?.slots.find((s) => s.teamNumber === teamNumber);

  /** Reload both teams from the example template for a 赛制. */
  const loadExample = (rs: RuleSet): void => {
    ruleSet.value = rs;
    const ex = exampleMatch(rs);
    match.mapId = ex.mapId;
    match.nettype = ex.nettype;
    match.aiFill = ex.aiFill;
    match.teams = ex.teams;
  };

  /** Pick a construct for a slot; resets its tuning to the new construct's defaults. */
  const setConstruct = (teamId: number, teamNumber: number, entityType: number): void => {
    const slot = findSlot(teamId, teamNumber);
    if (!slot) return;
    slot.entityType = entityType;
    slot.tuning = undefined;
  };

  /** Merge a partial tuning override into a slot. */
  const setTuning = (teamId: number, teamNumber: number, patch: Partial<SlotTuning>): void => {
    const slot = findSlot(teamId, teamNumber);
    if (!slot) return;
    slot.tuning = { ...(slot.tuning ?? {}), ...patch };
  };

  const teamCosts = computed<number[]>(() => match.teams.map((t) => computeTeamCost(t)));
  const costDelta = computed<number>(() =>
    teamCosts.value.length === 2 ? Math.abs((teamCosts.value[0] ?? 0) - (teamCosts.value[1] ?? 0)) : 0,
  );

  return {
    ruleSet,
    match,
    teamCosts,
    costDelta,
    slotCost: computeSlotCost,
    findSlot,
    loadExample,
    setConstruct,
    setTuning,
  };
}

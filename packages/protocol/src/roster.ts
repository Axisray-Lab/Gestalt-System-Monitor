/**
 * 赛制 (rule-set) → slot layout templates, and the read-only career stat panel.
 * A slot's career is fixed by the 赛制; the player picks the construct + tuning.
 * `mapId` (the concrete level id) is bound at launch time and is not fixed here.
 */
import { CareerId } from './team';

export enum RuleSet {
  RMUC2026 = 'RMUC2026',
  RMUL2026 = 'RMUL2026',
  RMUL2026_1V1 = 'RMUL2026_1V1',
}

export interface MapSlotTemplate {
  teamNumber: number; // slot number
  careerId: CareerId; // fixed
  /** Default construct; the player may pick another from the career's options. */
  defaultEntityType: number;
  /** Shipped asymmetric default per team (teamId → entity); UI may override. */
  entityTypeByTeam?: Record<number, number>;
}

export interface RuleSetTemplate {
  ruleSet: RuleSet;
  label: string;
  teamSize: number;
  slots: MapSlotTemplate[];
}

/** Default construct per career (career-default entity). */
export const CAREER_DEFAULT_ENTITY: Record<number, number> = {
  [CareerId.Hero]: 66000001,
  [CareerId.Engineer]: 66000014,
  [CareerId.Infantry]: 66000002,
  [CareerId.Sentry]: 66000005,
  [CareerId.Aerial]: 66000013,
  [CareerId.Radar]: 66000015,
  [CareerId.Dart]: 66000016,
};

export const RULESETS: Record<RuleSet, RuleSetTemplate> = {
  [RuleSet.RMUC2026]: {
    ruleSet: RuleSet.RMUC2026,
    label: 'RMUC 2026',
    teamSize: 6,
    slots: [
      // shipped 对照局: red(0)=ranged, blue(1)=melee
      { teamNumber: 1, careerId: CareerId.Hero, defaultEntityType: 66000001, entityTypeByTeam: { 0: 66000001, 1: 66000017 } },
      { teamNumber: 2, careerId: CareerId.Engineer, defaultEntityType: 66000014 },
      { teamNumber: 3, careerId: CareerId.Infantry, defaultEntityType: 66000002 },
      { teamNumber: 4, careerId: CareerId.Infantry, defaultEntityType: 66000008 },
      { teamNumber: 6, careerId: CareerId.Aerial, defaultEntityType: 66000013 },
      { teamNumber: 7, careerId: CareerId.Sentry, defaultEntityType: 66000005, entityTypeByTeam: { 0: 66000005, 1: 66000012 } },
    ],
  },
  [RuleSet.RMUL2026]: {
    ruleSet: RuleSet.RMUL2026,
    label: 'RMUL 2026',
    teamSize: 3,
    slots: [
      { teamNumber: 1, careerId: CareerId.Hero, defaultEntityType: 66000001 },
      { teamNumber: 3, careerId: CareerId.Infantry, defaultEntityType: 66000002 },
      { teamNumber: 7, careerId: CareerId.Sentry, defaultEntityType: 66000005 },
    ],
  },
  [RuleSet.RMUL2026_1V1]: {
    ruleSet: RuleSet.RMUL2026_1V1,
    label: 'RMUL 2026 1v1',
    teamSize: 1,
    slots: [{ teamNumber: 3, careerId: CareerId.Infantry, defaultEntityType: 66000002 }],
  },
};

/** Read-only career stats (rule面, not tunable) for an info panel. */
export interface CareerRules {
  hp: number;
  chassisPowerW: number; // 底盘功率
  firingHeatMax: number; // 热容 (Infinity = effectively none)
  coolingRate: number; // 散热
  capacitorMax: number; // 电容容量上限
}

export const CAREER_RULES: Record<number, CareerRules> = {
  [CareerId.Hero]: { hp: 200, chassisPowerW: 70, firingHeatMax: 140, coolingRate: 12, capacitorMax: 2000 },
  [CareerId.Engineer]: { hp: 250, chassisPowerW: 120, firingHeatMax: 0, coolingRate: 0, capacitorMax: 0 },
  [CareerId.Infantry]: { hp: 150, chassisPowerW: 60, firingHeatMax: 170, coolingRate: 5, capacitorMax: 2000 },
  [CareerId.Sentry]: { hp: 400, chassisPowerW: 100, firingHeatMax: 260, coolingRate: 30, capacitorMax: 2000 },
  [CareerId.Aerial]: { hp: 150, chassisPowerW: 70, firingHeatMax: 170, coolingRate: 10, capacitorMax: 2000 },
  [CareerId.Radar]: { hp: 180, chassisPowerW: 0, firingHeatMax: Infinity, coolingRate: 0, capacitorMax: 0 },
  [CareerId.Dart]: { hp: 180, chassisPowerW: 0, firingHeatMax: Infinity, coolingRate: 0, capacitorMax: 0 },
};

/** Build a fresh roster (per team) from a 赛制 template, seeded with defaults. */
export const buildDefaultRoster = (ruleSet: RuleSet, teamId: number) =>
  RULESETS[ruleSet].slots.map((s) => ({
    teamNumber: s.teamNumber,
    careerId: s.careerId,
    entityType: s.entityTypeByTeam?.[teamId] ?? s.defaultEntityType,
  }));

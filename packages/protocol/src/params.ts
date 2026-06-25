/**
 * UI-facing tunable-parameter specs for the team-builder sliders/controls.
 * Defaults come from a construct's T0 (see ./cost CONSTRUCT_DEFAULTS); the cost of
 * any value comes from ./cost COST.*.
 */
import { CONSTRUCT_DEFAULTS } from './cost';
import type { SlotTuning } from './team';

export type TuningKey = 'discharge' | 'ammo17' | 'ammo42' | 'fireRateHz' | 'spreadMax' | 'spreadMin' | 'speedSpread';

export interface ParamSpec {
  key: TuningKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

/** Slider spec per scalar tunable axis. */
export const TUNABLE_PARAMS: Record<TuningKey, ParamSpec> = {
  discharge: { key: 'discharge', label: '放电功率 (电容)', unit: 'W', min: 0, max: 300, step: 10 },
  ammo17: { key: 'ammo17', label: '17mm 弹仓', unit: '发', min: 0, max: 2000, step: 100 },
  ammo42: { key: 'ammo42', label: '42mm 弹仓', unit: '发', min: 0, max: 200, step: 5 },
  fireRateHz: { key: 'fireRateHz', label: '射频', unit: 'Hz', min: 2, max: 30, step: 1 },
  spreadMax: { key: 'spreadMax', label: '散布 (外)', unit: 'cm', min: 1, max: 20, step: 0.5 },
  spreadMin: { key: 'spreadMin', label: '散布 (内)', unit: 'cm', min: 0.25, max: 10, step: 0.25 },
  speedSpread: { key: 'speedSpread', label: '弹速波动', unit: 'cm/s', min: 0, max: 100, step: 5 },
};

const ALL_KEYS = Object.keys(TUNABLE_PARAMS) as TuningKey[];

/** Scalar params a construct exposes (= the keys present in its default tuning). */
export const paramsForConstruct = (entityType: number): ParamSpec[] => {
  const def = (CONSTRUCT_DEFAULTS[entityType] ?? {}) as SlotTuning;
  return ALL_KEYS.filter((k) => def[k] != null).map((k) => TUNABLE_PARAMS[k]);
};

/** The construct's default tuning (a fresh clone the UI can bind + mutate). */
export const defaultsForConstruct = (entityType: number): SlotTuning => ({ ...(CONSTRUCT_DEFAULTS[entityType] ?? {}) });

export const hasDart = (entityType: number): boolean => CONSTRUCT_DEFAULTS[entityType]?.dart != null;
export const hasEngineer = (entityType: number): boolean => CONSTRUCT_DEFAULTS[entityType]?.engineer != null;
export const hasRadar = (entityType: number): boolean => CONSTRUCT_DEFAULTS[entityType]?.radar != null;

// Option sets for the structured (non-slider) controls.
export const ENGINEER_ASSEMBLY_LEVELS = [1, 2, 3, 4] as const;
export const ENGINEER_CORE_POOLS = [2, 4, 6] as const;
export const DART_BASE_MODES = [
  { value: 0, label: '基地模式 1' },
  { value: 1, label: '基地模式 2' },
  { value: 2, label: '基地模式 3' },
  { value: 3, label: '基地模式 4' },
] as const;
export const RADAR_DETECTION_MODES = [
  { value: 0, label: '关' },
  { value: 1, label: '半场' },
  { value: 2, label: '全场' },
] as const;

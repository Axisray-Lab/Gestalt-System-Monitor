export interface StaticReplayDescriptor {
  key: string;
  label: string;
  assetPath: string;
}

export const RMUC2026_REGIONAL_REPLAYS = [
  {
    key: 'rmuc2026-east-final-m88',
    label:
      'RMUC2026 东部决赛 M88 · 山东科技大学 vs 中国石油大学（华东）· 推断弹量',
    assetPath: 'replays/rmuc2026-regionals/east-final-m88.json',
  },
  {
    key: 'rmuc2026-south-final-m88',
    label: 'RMUC2026 南部决赛 M88 · 五邑大学 vs 华南农业大学 · 推断弹量',
    assetPath: 'replays/rmuc2026-regionals/south-final-m88.json',
  },
  {
    key: 'rmuc2026-north-final-m90',
    label: 'RMUC2026 北部决赛 M90 · 东北大学 vs 哈尔滨工业大学 · 推断弹量',
    assetPath: 'replays/rmuc2026-regionals/north-final-m90.json',
  },
] as const satisfies readonly StaticReplayDescriptor[];

export function configuredStaticReplays(
  configured = import.meta.env.VITE_GSM_STATIC_REPLAYS
): readonly StaticReplayDescriptor[] {
  if (!configured) return [];
  if (configured === 'rmuc2026-regionals') return RMUC2026_REGIONAL_REPLAYS;
  throw new Error(`Unsupported VITE_GSM_STATIC_REPLAYS value: ${configured}`);
}

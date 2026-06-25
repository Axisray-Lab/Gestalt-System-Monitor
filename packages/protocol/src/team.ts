/**
 * Team-builder wire contract — the custom-match roster the SPA authors and the
 * agent launches (carried as an autostart parameter to a headless match).
 *
 * TARGET CONTRACT: defined for the SPA to build against. The agent does not yet
 * forward LaunchHeadlessRequest.match into an autostart parameter, and the game's
 * -roster parse is pending (game-side support, tracked separately).
 *
 * R&D 费 (cost) is a monitor-side visualization metric (computed in the SPA) and is
 * never part of this payload / never read by the game.
 */

/** Career id = the Class attribute value; fixed by the slot (read-only in the UI). */
export enum CareerId {
  Hero = 1001,
  Engineer = 1002,
  Infantry = 1003,
  Sentry = 1004,
  Aerial = 1005,
  Radar = 1006,
  Dart = 1007,
}

/** Per-slot tunable settings (the "research" surface). Sparse: any unset field
 *  falls back to the chosen construct's default (see ./cost CONSTRUCT_DEFAULTS).
 *  See ./params for the slider specs (label / unit / min / max / step). */
export interface SlotTuning {
  discharge?: number; // 放电功率 W — electric capacitor; 0 = no usable capacitor
  ammo17?: number; // 17mm physical magazine (rounds)
  ammo42?: number; // 42mm physical magazine (rounds)
  fireRateHz?: number; // 射频 — shots/s
  spreadMax?: number; // 散布 outer enclosing (cm) — lower = more accurate
  spreadMin?: number; // 散布 inner enclosing (cm)
  speedSpread?: number; // 弹速波动 — muzzle-velocity fluctuation
  dart?: { canOutpost: boolean; canBase: boolean; maxBaseMode: 0 | 1 | 2 | 3 };
  engineer?: { maxAssemblyLevel: 1 | 2 | 3 | 4; corePool: 2 | 4 | 6 };
  radar?: { maxLockRangeM: number; detectionMode: 0 | 1 | 2 };
}

export interface RosterSlotConfig {
  teamNumber: number; // slot number within the team (fixed by the 赛制)
  careerId: number; // fixed by the slot; echo-only
  entityType: number; // chosen construct id
  tuning?: SlotTuning; // sparse overrides; unset axes use the construct default
  // SEAM: AI strategy (move/target/fire modes) is added here by the Coach /
  // Unit-Strategy agent. Unset → the game uses its built-in per-team default.
}

export interface TeamConfig {
  teamId: number; // 0 / 1
  slots: RosterSlotConfig[];
}

export interface HeadlessMatchConfig {
  mapId: number;
  nettype: number;
  teams: TeamConfig[];
  aiFill: boolean;
  attrrecord?: boolean;
  attrrecordHz?: number;
  hudHidden?: boolean;
}

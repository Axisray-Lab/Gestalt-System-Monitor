/**
 * Team-builder wire contract — the custom-match roster payload the SPA authors and
 * the agent launches (carried as an autostart parameter to a headless match).
 *
 * This is the player-observable launch interface only. Cost/score and any
 * game-internal balance are NOT modeled here — the SPA obtains them at runtime
 * (see the agent's team-config endpoint) and the game never reads them.
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

/** One roster slot. `careerId` is fixed by the slot; the player picks `entityType`
 *  (the 构型) from that career's options and tunes the per-slot settings below. */
export interface RosterSlotConfig {
  teamNumber: number; // slot number within the team
  careerId: number; // fixed by the slot; echo-only
  entityType: number; // chosen construct id

  /** Sparse per-instance attribute overrides (attributeId → raw value). */
  paramOverrides?: Record<number, number>;

  // Optional per-slot match settings (present only when the slot exposes them):
  firingIntervalMs?: number;
  spread?: { maxEnclosing: number; minEnclosing: number };
  dart?: { canOutpost: boolean; canBase: boolean; maxBaseMode: 0 | 1 | 2 | 3 };
  engineer?: { maxAssemblyLevel: 1 | 2 | 3 | 4; corePool: 2 | 4 | 6; assemblyDurMsByLevel?: number[] };
  radar?: { maxLockRangeM: number; detectionMode: 0 | 1 | 2 };

  /** UI-side only (cost is computed from runtime config; not sent to the game). */
  slotCost?: number;
}

export interface TeamConfig {
  teamId: number; // 0 / 1
  slots: RosterSlotConfig[];
  teamCost?: number; // UI-side only
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

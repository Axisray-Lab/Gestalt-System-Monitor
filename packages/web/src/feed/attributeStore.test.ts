import { describe, expect, it } from 'vitest';
import {
  AttrId,
  type AttributeMapSyncType,
  type WatchAttributeMapsResult,
} from '@gsm/protocol';
import { AttributeStore } from './attributeStore';

function result(
  syncType: AttributeMapSyncType,
  mapId: number,
  attributes: Record<string, number>
): WatchAttributeMapsResult {
  return {
    watch_attribute_maps_results: [
      { sync_type: syncType, attribute_map_id: mapId, attributes },
    ],
  };
}

describe('AttributeStore replay lifecycle', () => {
  it('uses an explicit replay clock for robot freshness', () => {
    const store = new AttributeStore();
    const mapId = 101;
    store.applyResult(result(0, mapId, {
      [AttrId.Class]: 1003,
      [AttrId.TeamID]: 0,
      [AttrId.TeamNumber]: 1,
      [AttrId.Health]: 100,
      [AttrId.HealthMax]: 100,
    }), 10_000);

    expect(store.toSnapshot(13_500).vehicles).toHaveLength(1);
    expect(store.toSnapshot(13_501).vehicles).toHaveLength(0);
    expect(() => store.toSnapshot(Number.NaN)).toThrow(/time must be finite/);
  });

  it('removes a native recycle tombstone and accepts a later incremental recreation', () => {
    const store = new AttributeStore();
    const mapId = 101;
    store.applyResult(result(0, mapId, {
      [AttrId.Class]: 1003,
      [AttrId.TeamID]: 0,
      [AttrId.TeamNumber]: 1,
      [AttrId.Health]: 100,
      [AttrId.HealthMax]: 100,
    }));
    expect(store.toSnapshot().vehicles.map((vehicle) => vehicle.attributeMapId)).toEqual([mapId]);

    // RecycleAttributeMapEvent is an explicit sync_type 2 update.
    store.applyResult(result(2, mapId, {}));
    expect(store.toSnapshot().vehicles).toEqual([]);
    expect(store.referencedMapIds().has(mapId)).toBe(false);

    // If the id is reused, first-sight incremental data reconstructs it normally.
    store.applyResult(result(1, mapId, {
      [AttrId.Class]: 1003,
      [AttrId.TeamID]: 1,
      [AttrId.TeamNumber]: 2,
      [AttrId.Health]: 75,
      [AttrId.HealthMax]: 100,
    }));
    expect(store.toSnapshot().vehicles.map((vehicle) => vehicle.attributeMapId)).toEqual([mapId]);
  });

  it('projects replay buffs, engineer assembly, revive, dart and outpost fields', () => {
    const store = new AttributeStore();
    store.applyResult({
      watch_attribute_maps_results: [
        {
          sync_type: 0,
          attribute_map_id: 14,
          attributes: {
            [AttrId.Class]: 2001,
            [AttrId.TeamID]: 0,
            [AttrId.Health]: 1000,
            [AttrId.HealthMax]: 1000,
            [AttrId.EngineerTeamEnergyUnitStock]: 7,
            [AttrId.RMUC2026_Tech_L1]: 1,
            [AttrId.RMUC2026_Tech_L2]: 1,
            [AttrId.RMUC2026_Tech_L3]: 2,
            [AttrId.RMUC2026_Tech_L4]: 0,
            [AttrId.TM_BaseDamageCount]: 99,
            [AttrId.TM_DartBaseHitCount]: 2,
          },
        },
        {
          sync_type: 0,
          attribute_map_id: 1002,
          attributes: {
            [AttrId.PlayerID]: 2,
            [AttrId.Class]: 1002,
            [AttrId.TeamID]: 0,
            [AttrId.TeamNumber]: 2,
            [AttrId.Health]: 0,
            [AttrId.HealthMax]: 500,
            [AttrId.Defeated]: 1,
            [AttrId.ReviveProgress]: 500,
            [AttrId.ReviveProgressMax]: 1000,
            [AttrId.DefenseMultiplierThou]: 250,
            [AttrId.AttackMultiplierThou]: 500,
            [AttrId.ColdMultiplierThou]: 1000,
            [AttrId.RadarDoubleVulnerabilityActive]: 1,
            [AttrId.EngineerAssemblyMaxCompletedLevel]: 3,
          },
        },
        {
          sync_type: 0,
          attribute_map_id: 16,
          attributes: {
            [AttrId.Class]: 2002,
            [AttrId.TeamID]: 0,
            [AttrId.Health]: 1000,
            [AttrId.HealthMax]: 1000,
            [AttrId.OP_AngularSpeed]: -72_000,
            [AttrId.OP_RotationStopRequested]: 1,
          },
        },
      ],
    });

    const snapshot = store.toSnapshot();
    const engineer = snapshot.vehicles.find((vehicle) => vehicle.id === 2);
    const base = snapshot.vehicles.find((vehicle) => vehicle.kind === 'base');
    const outpost = snapshot.vehicles.find(
      (vehicle) => vehicle.kind === 'outpost'
    );
    expect(engineer).toMatchObject({
      respawnProgress: 0.5,
      buffs: ['def', 'atk', 'cool', 'vuln'],
      buffValues: { def: 250, atk: 500, cool: 1000 },
      engineerTeamEnergyCores: 7,
      engineerAssemblyLevel: 3,
      engineerAssemblyCounts: [1, 1, 2, 0],
    });
    expect(base?.dartHitCount).toBe(2);
    expect(outpost).toMatchObject({
      outpostAngularSpeedDeg: -72,
      outpostRotationStopRequested: true,
    });
  });
});

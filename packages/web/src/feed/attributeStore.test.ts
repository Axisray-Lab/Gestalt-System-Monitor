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
});

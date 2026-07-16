export type CompactUpdateMarker = 0 | 1 | 2;
export type RbReplayCompactUpdate = [number, number[], CompactUpdateMarker];
export type RbReplayFrame = [number, number | null, RbReplayCompactUpdate[]];

export interface RbReplayAttributeInfo {
  version: number;
  mapId: number;
  frameCount: number;
  durMs: number;
  gtMs: number;
}

export interface RbReplayAttributeFile {
  info: RbReplayAttributeInfo;
  frames: RbReplayFrame[];
}

export interface NativeAttributeEvent {
  kind: 'create' | 'change' | 'recycle';
  mapId: number;
  attributes: number[];
}

export interface AttributeMapUpdate {
  sync_type: 0 | 1 | 2;
  attribute_map_id: number;
  attributes: Record<string, number>;
}

export interface WatchAttributeMapsProjection {
  watch_attribute_maps_results: AttributeMapUpdate[];
}

export const COMPACT_FULL: 0;
export const COMPACT_DELTA: 1;
export const COMPACT_RECYCLE: 2;

export function decodeWorldAttributePacket(
  packetKind: string,
  data: Uint8Array | ArrayBuffer,
): NativeAttributeEvent[];

export function readRbReplayWorldAttributes(
  replayPath: string,
  loadFrames?: boolean,
): RbReplayAttributeFile;

export function projectCompactAttributeUpdates(
  updates: RbReplayCompactUpdate[],
  state?: Map<number, Record<string, number>>,
): WatchAttributeMapsProjection;

import * as THREE from 'three';

export type RoundPreviewRegionKey = string;
export type RoundPreviewSeriesKey = string;

/** Explicit identity for one independently selectable RMUC round. */
export interface RoundPreviewSlot {
  key: string;
  regionKey: RoundPreviewRegionKey;
  seriesKey: RoundPreviewSeriesKey;
  roundNumber: number;
  label: string;
}

export type RoundPreviewEntityKind = 'robot' | 'building';
export type RoundPreviewTeam = 'red' | 'blue';

/**
 * One lightweight overview entity in monitor-local metres (Three.js Y-up).
 * Coordinate conversion belongs at the replay parsing boundary; this render
 * batch intentionally does not guess whether a source used UE centimetres.
 */
export interface RoundPreviewEntity {
  key: string;
  entityId: string | number;
  kind: RoundPreviewEntityKind;
  team: RoundPreviewTeam;
  x: number;
  y: number;
  z: number;
  defeated: boolean;
}

/** A complete, already-interpolated overview sample for all visible rounds. */
export interface RoundPreviewFrame {
  timeMs: number;
  entities: readonly RoundPreviewEntity[];
}

export interface RoundPreviewBatchStats {
  slotCount: number;
  visibleSlotCount: number;
  robotCount: number;
  buildingCount: number;
  /** Fixed upper bound while the batch is non-empty: board + robot + building. */
  drawCalls: number;
  /** Rendered triangles, excluding the one optional full MatchUnit. */
  triangles: number;
  frameTimeMs: number | null;
  clockTimeMs: number;
  /** Wall-clock cost of the most recent complete setFrame validation + upload. */
  updateMs: number;
}

export interface RoundPreviewLayoutOptions {
  boardWidth: number;
  boardDepth: number;
  roundGap: number;
  seriesGap: number;
  regionGap: number;
}

export interface RoundPreviewLayoutEntry {
  slot: RoundPreviewSlot;
  position: THREE.Vector3;
  instanceId: number;
}

export interface RoundPreviewLayout {
  entries: readonly RoundPreviewLayoutEntry[];
  bounds: THREE.Box3;
}

const DEFAULT_LAYOUT: Readonly<RoundPreviewLayoutOptions> = Object.freeze({
  // MatchUnit's placeholder RMUC footprint is 18.8 m x 33.6 m. Keeping the
  // same footprint means the one focused high-detail unit can be promoted in
  // place without overlapping an adjacent round.
  boardWidth: 18.8,
  boardDepth: 33.6,
  roundGap: 5,
  seriesGap: 11,
  regionGap: 42,
});

const BOARD_HEIGHT = 0.16;
const BOARD_TOP = -0.03;
const ENTITY_LIFT = 0.42;
const NORMAL_BRIGHTNESS = 1;
const DIM_BRIGHTNESS = 0.24;
const DEFEATED_BRIGHTNESS = 0.22;
const REGION_COLORS = [0x275b7a, 0x5a416f, 0x416544, 0x76562d, 0x365f63] as const;
const TEAM_COLORS: Readonly<Record<RoundPreviewTeam, number>> = Object.freeze({
  red: 0xff4d62,
  blue: 0x4d9dff,
});

interface RegionLayout {
  key: string;
  groups: SeriesGroup[];
  width: number;
  depth: number;
  columns: number;
}

interface SeriesGroup {
  key: string;
  slots: RoundPreviewSlot[];
}

interface StableEntityIdentity {
  key: string;
  entityId: string | number;
  kind: RoundPreviewEntityKind;
  team: RoundPreviewTeam;
  entry: RoundPreviewLayoutEntry;
}

function finitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Round preview ${name} must be a finite positive number`);
  }
}

function validateSlot(slot: RoundPreviewSlot, index: number): void {
  if (slot.key.trim().length === 0) throw new Error(`Round preview slot ${index} has an empty key`);
  if (slot.regionKey.trim().length === 0) {
    throw new Error(`Round preview slot ${slot.key} has an empty regionKey`);
  }
  if (slot.seriesKey.trim().length === 0) {
    throw new Error(`Round preview slot ${slot.key} has an empty seriesKey`);
  }
  if (!Number.isInteger(slot.roundNumber) || slot.roundNumber < 1) {
    throw new Error(`Round preview slot ${slot.key} has an invalid roundNumber`);
  }
  if (slot.label.trim().length === 0) {
    throw new Error(`Round preview slot ${slot.key} has an empty label`);
  }
}

function validateLayoutOptions(options: RoundPreviewLayoutOptions): void {
  finitePositive(options.boardWidth, 'boardWidth');
  finitePositive(options.boardDepth, 'boardDepth');
  finitePositive(options.roundGap, 'roundGap');
  finitePositive(options.seriesGap, 'seriesGap');
  finitePositive(options.regionGap, 'regionGap');
}

function groupSlots(slots: readonly RoundPreviewSlot[]): RegionLayout[] {
  const regionOrder: string[] = [];
  const seriesOrder = new Map<string, string[]>();
  const seriesSlots = new Map<string, RoundPreviewSlot[]>();
  const seenKeys = new Set<string>();
  const seenRounds = new Set<string>();

  slots.forEach((slot, index) => {
    validateSlot(slot, index);
    if (seenKeys.has(slot.key)) throw new Error(`Duplicate round preview key: ${slot.key}`);
    seenKeys.add(slot.key);

    if (!seriesOrder.has(slot.regionKey)) {
      regionOrder.push(slot.regionKey);
      seriesOrder.set(slot.regionKey, []);
    }
    const groupKey = `${slot.regionKey}\u0000${slot.seriesKey}`;
    if (!seriesSlots.has(groupKey)) {
      seriesOrder.get(slot.regionKey)!.push(groupKey);
      seriesSlots.set(groupKey, []);
    }
    const roundKey = `${groupKey}\u0000${slot.roundNumber}`;
    if (seenRounds.has(roundKey)) {
      throw new Error(
        `Duplicate roundNumber ${slot.roundNumber} in ${slot.regionKey}/${slot.seriesKey}`
      );
    }
    seenRounds.add(roundKey);
    seriesSlots.get(groupKey)!.push(slot);
  });

  return regionOrder.map((regionKey) => ({
    key: regionKey,
    groups: seriesOrder.get(regionKey)!.map((groupKey) => {
      const grouped = seriesSlots.get(groupKey)!.sort((a, b) => a.roundNumber - b.roundNumber);
      if (grouped.length > 4) {
        throw new Error(`Round preview series ${grouped[0].seriesKey} contains more than four rounds`);
      }
      return { key: groupKey, slots: grouped };
    }),
    width: 0,
    depth: 0,
    columns: 0,
  }));
}

/**
 * Deterministic, non-stacked RMUC layout. Rounds in one series occupy a 2x2
 * group and region blocks occupy a near-square outer grid. Input order defines
 * region/series order; roundNumber defines order inside each series.
 */
export function buildRoundPreviewLayout(
  slots: readonly RoundPreviewSlot[],
  overrides: Partial<RoundPreviewLayoutOptions> = {}
): RoundPreviewLayout {
  const options = { ...DEFAULT_LAYOUT, ...overrides };
  validateLayoutOptions(options);
  if (slots.length === 0) return { entries: [], bounds: new THREE.Box3().makeEmpty() };

  const regions = groupSlots(slots);
  const roundStrideX = options.boardWidth + options.roundGap;
  const roundStrideZ = options.boardDepth + options.roundGap;
  const groupWidth = options.boardWidth * 2 + options.roundGap;
  const groupDepth = options.boardDepth * 2 + options.roundGap;
  const groupStrideX = groupWidth + options.seriesGap;
  const groupStrideZ = groupDepth + options.seriesGap;

  for (const region of regions) {
    const aspect = groupDepth / groupWidth;
    region.columns = Math.max(1, Math.ceil(Math.sqrt(region.groups.length * aspect)));
    const rows = Math.ceil(region.groups.length / region.columns);
    region.width = region.columns * groupWidth + (region.columns - 1) * options.seriesGap;
    region.depth = rows * groupDepth + (rows - 1) * options.seriesGap;
  }

  const regionColumns = Math.max(1, Math.ceil(Math.sqrt(regions.length)));
  const regionRows = Math.ceil(regions.length / regionColumns);
  const maxRegionWidth = Math.max(...regions.map((region) => region.width));
  const maxRegionDepth = Math.max(...regions.map((region) => region.depth));
  const regionStrideX = maxRegionWidth + options.regionGap;
  const regionStrideZ = maxRegionDepth + options.regionGap;
  const worldWidth = regionColumns * maxRegionWidth + (regionColumns - 1) * options.regionGap;
  const worldDepth = regionRows * maxRegionDepth + (regionRows - 1) * options.regionGap;

  const entries: RoundPreviewLayoutEntry[] = [];
  const bounds = new THREE.Box3().makeEmpty();
  let instanceId = 0;
  regions.forEach((region, regionIndex) => {
    const regionColumn = regionIndex % regionColumns;
    const regionRow = Math.floor(regionIndex / regionColumns);
    const regionCenterX =
      regionColumn * regionStrideX + maxRegionWidth / 2 - worldWidth / 2;
    const regionCenterZ =
      regionRow * regionStrideZ + maxRegionDepth / 2 - worldDepth / 2;
    const groupRows = Math.ceil(region.groups.length / region.columns);
    const usedWidth =
      region.columns * groupWidth + (region.columns - 1) * options.seriesGap;
    const usedDepth = groupRows * groupDepth + (groupRows - 1) * options.seriesGap;

    region.groups.forEach((group, groupIndex) => {
      const groupColumn = groupIndex % region.columns;
      const groupRow = Math.floor(groupIndex / region.columns);
      const groupCenterX =
        regionCenterX + groupColumn * groupStrideX + groupWidth / 2 - usedWidth / 2;
      const groupCenterZ =
        regionCenterZ + groupRow * groupStrideZ + groupDepth / 2 - usedDepth / 2;
      const rows = Math.ceil(group.slots.length / 2);

      group.slots.forEach((slot, slotIndex) => {
        const row = Math.floor(slotIndex / 2);
        const firstInRow = row * 2;
        const countInRow = Math.min(2, group.slots.length - firstInRow);
        const column = slotIndex - firstInRow;
        const x = groupCenterX + (column - (countInRow - 1) / 2) * roundStrideX;
        const z = groupCenterZ + (row - (rows - 1) / 2) * roundStrideZ;
        const position = new THREE.Vector3(x, 0, z);
        entries.push({ slot, position, instanceId });
        instanceId += 1;
        bounds.expandByPoint(
          new THREE.Vector3(x - options.boardWidth / 2, -BOARD_HEIGHT, z - options.boardDepth / 2)
        );
        bounds.expandByPoint(
          new THREE.Vector3(x + options.boardWidth / 2, 2, z + options.boardDepth / 2)
        );
      });
    });
  });

  return { entries, bounds };
}

function disposeRenderable(renderable: THREE.InstancedMesh | THREE.Points): void {
  renderable.geometry.dispose();
  const material = renderable.material;
  if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
  else material.dispose();
}

/**
 * One scene-level LOD renderer for every RMUC round. It intentionally owns no
 * timer, MatchUnit, labels, replay parsing, or coordinate conversion. The host
 * supplies a single shared clock and one complete display frame.
 */
export class PreviewBatch {
  readonly root = new THREE.Group();

  private layout: RoundPreviewLayout = {
    entries: [],
    bounds: new THREE.Box3().makeEmpty(),
  };
  private entryByKey = new Map<string, RoundPreviewLayoutEntry>();
  private boardMesh: THREE.InstancedMesh | null = null;
  private robotPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private buildingMesh: THREE.InstancedMesh | null = null;
  private frame: RoundPreviewFrame | null = null;
  /** Established by the first frame; overview tracks have fixed entity order. */
  private entityIdentity: StableEntityIdentity[] | null = null;
  private focusedKey: string | null = null;
  private clockTimeMs = 0;
  private robotCount = 0;
  private buildingCount = 0;
  private robotCapacity = 0;
  private buildingCapacity = 0;
  private triangles = 0;
  private updateMs = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly quaternion = new THREE.Quaternion();
  private disposed = false;

  constructor(
    slots: readonly RoundPreviewSlot[],
    private readonly layoutOptions: Partial<RoundPreviewLayoutOptions> = {}
  ) {
    this.root.name = 'RMUC round preview batch';
    this.setSlots(slots);
  }

  setSlots(slots: readonly RoundPreviewSlot[]): void {
    this.assertAlive();
    const nextLayout = buildRoundPreviewLayout(slots, this.layoutOptions);
    if (this.focusedKey !== null && !nextLayout.entries.some((entry) => entry.slot.key === this.focusedKey)) {
      throw new Error(`Focused round preview key is absent from the new layout: ${this.focusedKey}`);
    }
    this.layout = nextLayout;
    this.entryByKey = new Map(nextLayout.entries.map((entry) => [entry.slot.key, entry]));
    if (this.entityIdentity) {
      for (const identity of this.entityIdentity) identity.entry = this.requireEntry(identity.key);
    }
    this.replaceBoardMesh();
    if (this.frame) {
      this.validateStableEntities(this.frame.entities);
      this.applyEntityInstances(this.frame.entities);
    }
  }

  hasSlot(key: string): boolean {
    return this.entryByKey.has(key);
  }

  slot(key: string): RoundPreviewSlot | undefined {
    return this.entryByKey.get(key)?.slot;
  }

  slotPosition(key: string, target = new THREE.Vector3()): THREE.Vector3 {
    const entry = this.requireEntry(key);
    return target.copy(entry.position);
  }

  slotBounds(key: string, target = new THREE.Box3()): THREE.Box3 {
    const entry = this.requireEntry(key);
    const options = { ...DEFAULT_LAYOUT, ...this.layoutOptions };
    return target.set(
      new THREE.Vector3(
        entry.position.x - options.boardWidth / 2,
        -BOARD_HEIGHT,
        entry.position.z - options.boardDepth / 2
      ),
      new THREE.Vector3(
        entry.position.x + options.boardWidth / 2,
        2,
        entry.position.z + options.boardDepth / 2
      )
    );
  }

  worldBounds(target = new THREE.Box3()): THREE.Box3 {
    return target.copy(this.layout.bounds);
  }

  get pickTargets(): readonly THREE.Object3D[] {
    return this.boardMesh ? [this.boardMesh] : [];
  }

  pick(instanceId: number): RoundPreviewSlot | null {
    if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= this.layout.entries.length) {
      return null;
    }
    return this.layout.entries[instanceId].slot;
  }

  setFocused(key: string | null): void {
    this.assertAlive();
    if (key !== null) this.requireEntry(key);
    if (key === this.focusedKey) return;
    this.focusedKey = key;
    this.applyBoardInstances();
    if (this.frame) this.applyEntityInstances(this.frame.entities);
  }

  /** The host owns play/pause/seeking and drives one clock for the whole batch. */
  setClock(timeMs: number): void {
    this.assertAlive();
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      throw new Error('Round preview clock must be a finite non-negative number');
    }
    this.clockTimeMs = timeMs;
  }

  /** Replace all lightweight entities in one atomic, allocation-bounded update. */
  setFrame(frame: RoundPreviewFrame): void {
    this.assertAlive();
    const updateStartedAt = performance.now();
    if (!Number.isFinite(frame.timeMs) || frame.timeMs < 0) {
      throw new Error('Round preview frame timeMs must be a finite non-negative number');
    }
    if (this.entityIdentity === null) this.establishEntityIdentity(frame.entities);
    else this.validateStableEntities(frame.entities);
    this.frame = frame;
    this.applyEntityInstances(frame.entities);
    this.updateMs = performance.now() - updateStartedAt;
  }

  get stats(): RoundPreviewBatchStats {
    return {
      slotCount: this.layout.entries.length,
      visibleSlotCount: Math.max(0, this.layout.entries.length - (this.focusedKey === null ? 0 : 1)),
      robotCount: this.robotCount,
      buildingCount: this.buildingCount,
      drawCalls:
        (this.boardMesh && this.layout.entries.length > 0 ? 1 : 0) +
        (this.robotPoints && this.robotCount > 0 ? 1 : 0) +
        (this.buildingMesh && this.buildingCount > 0 ? 1 : 0),
      triangles: this.triangles,
      frameTimeMs: this.frame?.timeMs ?? null,
      clockTimeMs: this.clockTimeMs,
      updateMs: this.updateMs,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearMeshes();
    this.entryByKey.clear();
    this.frame = null;
    this.entityIdentity = null;
    this.root.clear();
  }

  private replaceBoardMesh(): void {
    if (this.boardMesh) {
      this.root.remove(this.boardMesh);
      disposeRenderable(this.boardMesh);
      this.boardMesh = null;
    }
    const count = this.layout.entries.length;
    if (count === 0) {
      this.triangles = 0;
      return;
    }
    const options = { ...DEFAULT_LAYOUT, ...this.layoutOptions };
    const geometry = new THREE.BoxGeometry(options.boardWidth, BOARD_HEIGHT, options.boardDepth);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.58,
      depthWrite: true,
      toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = 'RMUC round preview boards';
    mesh.layers.enable(1);
    mesh.renderOrder = -20;
    mesh.frustumCulled = false;
    this.boardMesh = mesh;
    this.root.add(mesh);
    this.applyBoardInstances();
    this.triangles = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3 * count;
  }

  private applyBoardInstances(): void {
    const mesh = this.boardMesh;
    if (!mesh) return;
    const regionIndexes = new Map<string, number>();
    for (const entry of this.layout.entries) {
      let regionIndex = regionIndexes.get(entry.slot.regionKey);
      if (regionIndex === undefined) {
        regionIndex = regionIndexes.size;
        regionIndexes.set(entry.slot.regionKey, regionIndex);
      }
      const hidden = entry.slot.key === this.focusedKey;
      this.position.set(entry.position.x, BOARD_TOP - BOARD_HEIGHT / 2, entry.position.z);
      this.scale.setScalar(hidden ? 0 : 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(entry.instanceId, this.matrix);
      const brightness = this.focusedKey === null ? NORMAL_BRIGHTNESS : DIM_BRIGHTNESS;
      this.color.setHex(REGION_COLORS[regionIndex % REGION_COLORS.length]).multiplyScalar(brightness);
      mesh.setColorAt(entry.instanceId, this.color);
    }
    mesh.count = this.layout.entries.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private applyEntityInstances(entities: readonly RoundPreviewEntity[]): void {
    const stableIdentity = this.entityIdentity;
    if (!stableIdentity) throw new Error('Round preview entity identity is not established');
    this.robotPoints = this.ensureRobotPoints(this.robotPoints, this.robotCapacity);
    this.buildingMesh = this.ensureBuildingMesh(this.buildingMesh, this.buildingCapacity);
    let robotIndex = 0;
    let buildingIndex = 0;
    for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
      const entity = entities[entityIndex];
      if (entity.key === this.focusedKey) continue;
      const entry = stableIdentity[entityIndex].entry;
      if (entity.kind === 'robot') {
        this.writeRobotPoint(this.robotPoints!, robotIndex, entity, entry);
        robotIndex += 1;
      } else {
        this.writeBuildingInstance(this.buildingMesh!, buildingIndex, entity, entry);
        buildingIndex += 1;
      }
    }
    this.robotCount = robotIndex;
    this.buildingCount = buildingIndex;
    this.finishRobotPointsUpdate(this.robotPoints, robotIndex);
    this.finishEntityMeshUpdate(this.buildingMesh, buildingIndex);
    const buildingTriangles = this.buildingMesh?.geometry.index
      ? this.buildingMesh.geometry.index.count / 3
      : (this.buildingMesh?.geometry.attributes.position?.count ?? 0) / 3;
    const boardTriangles = this.boardMesh?.geometry.index
      ? this.boardMesh.geometry.index.count / 3
      : (this.boardMesh?.geometry.attributes.position?.count ?? 0) / 3;
    this.triangles =
      boardTriangles * this.layout.entries.length +
      buildingTriangles * this.buildingCount;
  }

  private ensureRobotPoints(
    current: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null,
    capacity: number
  ): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null {
    const currentCapacity = current?.geometry.getAttribute('position')?.count ?? 0;
    if (current && currentCapacity >= capacity) return current;
    if (current) {
      this.root.remove(current);
      disposeRenderable(current);
    }
    if (capacity === 0) return null;

    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(
      THREE.DynamicDrawUsage
    );
    const colors = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(
      THREE.DynamicDrawUsage
    );
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);
    geometry.setDrawRange(0, 0);
    const material = new THREE.PointsMaterial({
      size: 0.72,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const points = new THREE.Points(geometry, material);
    points.name = 'RMUC round preview robots';
    points.renderOrder = 1002;
    points.frustumCulled = false;
    this.root.add(points);
    return points;
  }

  private ensureBuildingMesh(
    current: THREE.InstancedMesh | null,
    capacity: number
  ): THREE.InstancedMesh | null {
    if (current && current.instanceMatrix.count >= capacity) return current;
    if (current) {
      this.root.remove(current);
      disposeRenderable(current);
    }
    if (capacity === 0) return null;
    const geometry = new THREE.BoxGeometry(0.88, 0.88, 0.88);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = 'RMUC round preview buildings';
    mesh.renderOrder = 1001;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    return mesh;
  }

  private writeRobotPoint(
    points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>,
    pointIndex: number,
    entity: RoundPreviewEntity,
    entry: RoundPreviewLayoutEntry
  ): void {
    const positions = points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colors = points.geometry.getAttribute('color') as THREE.BufferAttribute;
    positions.setXYZ(
      pointIndex,
      entry.position.x + entity.x,
      entry.position.y + entity.y + ENTITY_LIFT,
      entry.position.z + entity.z
    );
    const brightness =
      (this.focusedKey === null ? NORMAL_BRIGHTNESS : DIM_BRIGHTNESS) *
      (entity.defeated ? DEFEATED_BRIGHTNESS : 1);
    this.color.setHex(TEAM_COLORS[entity.team]).multiplyScalar(brightness);
    colors.setXYZ(pointIndex, this.color.r, this.color.g, this.color.b);
  }

  private writeBuildingInstance(
    mesh: THREE.InstancedMesh,
    instanceId: number,
    entity: RoundPreviewEntity,
    entry: RoundPreviewLayoutEntry
  ): void {
    this.position.set(
      entry.position.x + entity.x,
      entry.position.y + entity.y + ENTITY_LIFT,
      entry.position.z + entity.z
    );
    const size = entity.defeated ? 0.62 : 1;
    this.scale.setScalar(size);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    mesh.setMatrixAt(instanceId, this.matrix);
    const brightness =
      (this.focusedKey === null ? NORMAL_BRIGHTNESS : DIM_BRIGHTNESS) *
      (entity.defeated ? DEFEATED_BRIGHTNESS : 1);
    this.color.setHex(TEAM_COLORS[entity.team]).multiplyScalar(brightness);
    mesh.setColorAt(instanceId, this.color);
  }

  private finishRobotPointsUpdate(
    points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null,
    count: number
  ): void {
    if (!points) return;
    points.geometry.setDrawRange(0, count);
    points.geometry.getAttribute('position').needsUpdate = true;
    points.geometry.getAttribute('color').needsUpdate = true;
  }

  private finishEntityMeshUpdate(mesh: THREE.InstancedMesh | null, count: number): void {
    if (!mesh) return;
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private establishEntityIdentity(entities: readonly RoundPreviewEntity[]): void {
    const seen = new Set<string>();
    const identity: StableEntityIdentity[] = new Array(entities.length);
    let robotCapacity = 0;
    let buildingCapacity = 0;
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index];
      this.validateEntityValue(entity);
      if (!this.entryByKey.has(entity.key)) {
        throw new Error(`Round preview entity references an unknown slot: ${entity.key}`);
      }
      if (
        (typeof entity.entityId !== 'string' && typeof entity.entityId !== 'number') ||
        (typeof entity.entityId === 'string' && entity.entityId.length === 0) ||
        (typeof entity.entityId === 'number' && !Number.isFinite(entity.entityId))
      ) {
        throw new Error(`Round preview entity at index ${index} has an invalid entityId`);
      }
      const identityKey = `${entity.key}\u0000${entity.entityId}`;
      if (seen.has(identityKey)) throw new Error(`Duplicate round preview entity: ${identityKey}`);
      seen.add(identityKey);
      identity[index] = {
        key: entity.key,
        entityId: entity.entityId,
        kind: entity.kind,
        team: entity.team,
        entry: this.requireEntry(entity.key),
      };
      if (entity.kind === 'robot') robotCapacity += 1;
      else buildingCapacity += 1;
    }
    this.entityIdentity = identity;
    this.robotCapacity = robotCapacity;
    this.buildingCapacity = buildingCapacity;
  }

  /** Hot path: stable overview tracks require no Set, string key, or array allocation. */
  private validateStableEntities(entities: readonly RoundPreviewEntity[]): void {
    const identity = this.entityIdentity;
    if (!identity) throw new Error('Round preview entity identity is not established');
    if (entities.length !== identity.length) {
      throw new Error(
        `Round preview entity count changed from ${identity.length} to ${entities.length}`
      );
    }
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index];
      const expected = identity[index];
      if (
        entity.key !== expected.key ||
        entity.entityId !== expected.entityId ||
        entity.kind !== expected.kind ||
        entity.team !== expected.team
      ) {
        throw new Error(`Round preview entity identity changed at index ${index}`);
      }
      this.validateEntityValue(entity);
    }
  }

  private validateEntityValue(entity: RoundPreviewEntity): void {
    if (entity.kind !== 'robot' && entity.kind !== 'building') {
      throw new Error(`Round preview entity ${entity.entityId} has an invalid kind`);
    }
    if (entity.team !== 'red' && entity.team !== 'blue') {
      throw new Error(`Round preview entity ${entity.entityId} has an invalid team`);
    }
    if (
      !Number.isFinite(entity.x) ||
      !Number.isFinite(entity.y) ||
      !Number.isFinite(entity.z)
    ) {
      throw new Error(`Round preview entity ${entity.entityId} has a non-finite position`);
    }
    if (typeof entity.defeated !== 'boolean') {
      throw new Error(`Round preview entity ${entity.entityId} has an invalid defeated flag`);
    }
  }

  private clearMeshes(): void {
    if (this.boardMesh) {
      this.root.remove(this.boardMesh);
      disposeRenderable(this.boardMesh);
    }
    if (this.robotPoints) {
      this.root.remove(this.robotPoints);
      disposeRenderable(this.robotPoints);
    }
    if (this.buildingMesh) {
      this.root.remove(this.buildingMesh);
      disposeRenderable(this.buildingMesh);
    }
    this.boardMesh = null;
    this.robotPoints = null;
    this.buildingMesh = null;
    this.robotCount = 0;
    this.buildingCount = 0;
    this.robotCapacity = 0;
    this.buildingCapacity = 0;
    this.triangles = 0;
    this.updateMs = 0;
  }

  private requireEntry(key: string): RoundPreviewLayoutEntry {
    const entry = this.entryByKey.get(key);
    if (!entry) throw new Error(`Unknown round preview key: ${key}`);
    return entry;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('Round preview batch has been disposed');
  }
}

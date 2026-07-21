import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  PreviewBatch,
  buildRoundPreviewLayout,
  type RoundPreviewEntity,
  type RoundPreviewSlot,
} from './PreviewBatch';

function slot(
  key: string,
  regionKey: string,
  seriesKey: string,
  roundNumber: number
): RoundPreviewSlot {
  return { key, regionKey, seriesKey, roundNumber, label: key };
}

function rmucSlots(): RoundPreviewSlot[] {
  const slots: RoundPreviewSlot[] = [];
  const regionRounds = [203, 204, 206] as const;
  regionRounds.forEach((roundCount, regionIndex) => {
    let roundIndex = 0;
    let seriesIndex = 0;
    while (roundIndex < roundCount) {
      const seriesKey = `r${regionIndex}-m${seriesIndex}`;
      const count = Math.min(4, roundCount - roundIndex);
      for (let roundNumber = 1; roundNumber <= count; roundNumber++) {
        slots.push(
          slot(
            `${seriesKey}-g${roundNumber}`,
            `region-${regionIndex}`,
            seriesKey,
            roundNumber
          )
        );
        roundIndex += 1;
      }
      seriesIndex += 1;
    }
  });
  return slots;
}

describe('buildRoundPreviewLayout', () => {
  it('lays series rounds out on one plane without stacking', () => {
    const layout = buildRoundPreviewLayout([
      slot('m1-g2', 'east', 'm1', 2),
      slot('m1-g1', 'east', 'm1', 1),
      slot('m2-g1', 'east', 'm2', 1),
      slot('m3-g1', 'south', 'm3', 1),
    ]);

    expect(layout.entries.map((entry) => entry.slot.key)).toEqual([
      'm1-g1',
      'm1-g2',
      'm2-g1',
      'm3-g1',
    ]);
    expect(layout.entries.every((entry) => entry.position.y === 0)).toBe(true);
    expect(layout.entries[0].position.distanceTo(layout.entries[1].position)).toBeLessThan(
      layout.entries[0].position.distanceTo(layout.entries[2].position)
    );
    expect(layout.bounds.isEmpty()).toBe(false);
  });

  it('rejects duplicate identities and series larger than the approved 2x2 group', () => {
    const duplicate = slot('duplicate', 'east', 'm1', 1);
    expect(() => buildRoundPreviewLayout([duplicate, duplicate])).toThrow(/Duplicate/);
    expect(() =>
      buildRoundPreviewLayout(
        Array.from({ length: 5 }, (_, index) => slot(`g${index}`, 'east', 'm1', index + 1))
      )
    ).toThrow(/more than four/);
  });
});

describe('PreviewBatch', () => {
  it('maps InstancedMesh instance ids back to explicit round metadata', () => {
    const slots = [slot('g1', 'east', 'm1', 1), slot('g2', 'east', 'm1', 2)];
    const batch = new PreviewBatch(slots);

    expect(batch.pickTargets).toHaveLength(1);
    expect(batch.pick(0)).toEqual(slots[0]);
    expect(batch.pick(1)).toEqual(slots[1]);
    expect(batch.pick(2)).toBeNull();
    batch.dispose();
  });

  it('hides exactly the focused preview slot while keeping all other slots batched', () => {
    const slots = rmucSlots();
    const batch = new PreviewBatch(slots);
    const selected = slots[300].key;

    batch.setFocused(selected);

    expect(batch.stats.slotCount).toBe(613);
    expect(batch.stats.visibleSlotCount).toBe(612);
    const selectedIndex = Array.from({ length: slots.length }, (_, index) => index).find(
      (index) => batch.pick(index)?.key === selected
    );
    expect(selectedIndex).toBeDefined();
    const board = batch.pickTargets[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    board.getMatrixAt(selectedIndex!, matrix);
    expect(matrix.elements[0]).toBe(0);
    expect(matrix.elements[5]).toBe(0);
    expect(matrix.elements[10]).toBe(0);

    batch.setFocused(null);
    expect(batch.stats.visibleSlotCount).toBe(613);
    batch.dispose();
  });

  it('uploads 613 rounds as one reusable robot point draw plus two mesh draws', () => {
    const slots = rmucSlots();
    const entities: RoundPreviewEntity[] = [];
    for (const round of slots) {
      for (let robot = 0; robot < 12; robot++) {
        entities.push({
          key: round.key,
          entityId: robot,
          kind: 'robot',
          team: robot < 6 ? 'red' : 'blue',
          x: (robot % 4) - 1.5,
          y: 0,
          z: Math.floor(robot / 4) - 1,
          defeated: robot === 3,
        });
      }
      for (let building = 0; building < 4; building++) {
        entities.push({
          key: round.key,
          entityId: 100 + building,
          kind: 'building',
          team: building < 2 ? 'red' : 'blue',
          x: building % 2 === 0 ? -6 : 6,
          y: 0,
          z: building < 2 ? -12 : 12,
          defeated: false,
        });
      }
    }
    const batch = new PreviewBatch(slots);
    batch.setClock(12_500);
    batch.setFrame({ timeMs: 12_500, entities });

    expect(batch.stats).toMatchObject({
      slotCount: 613,
      visibleSlotCount: 613,
      robotCount: 7_356,
      buildingCount: 2_452,
      drawCalls: 3,
      frameTimeMs: 12_500,
      clockTimeMs: 12_500,
    });
    expect(batch.stats.triangles).toBeLessThan(100_000);
    expect(batch.stats.updateMs).toBeGreaterThanOrEqual(0);

    const robotPoints = batch.root.getObjectByName('RMUC round preview robots');
    expect(robotPoints).toBeInstanceOf(THREE.Points);
    const points = robotPoints as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    expect(points.material.vertexColors).toBe(true);
    expect(points.geometry.drawRange).toMatchObject({ start: 0, count: 7_356 });
    const positionAttribute = points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colorAttribute = points.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(positionAttribute.count).toBe(7_356);
    expect(colorAttribute.count).toBe(7_356);
    const positions = positionAttribute.array;
    const colors = colorAttribute.array;
    const firstSlotPosition = batch.slotPosition(slots[0].key);
    expect(positionAttribute.getX(0)).toBeCloseTo(firstSlotPosition.x - 1.5);
    expect(positionAttribute.getY(0)).toBeCloseTo(0.42);
    expect(positionAttribute.getZ(0)).toBeCloseTo(firstSlotPosition.z - 1);

    entities[0].x += 1;
    batch.setFrame({ timeMs: 12_600, entities });
    const updatedPoints = batch.root.getObjectByName('RMUC round preview robots') as THREE.Points<
      THREE.BufferGeometry,
      THREE.PointsMaterial
    >;
    expect(updatedPoints).toBe(points);
    expect(updatedPoints.geometry.getAttribute('position').array).toBe(positions);
    expect(updatedPoints.geometry.getAttribute('color').array).toBe(colors);
    expect(positionAttribute.getX(0)).toBeCloseTo(firstSlotPosition.x - 0.5);

    batch.setFocused(slots[300].key);
    expect(batch.stats).toMatchObject({
      visibleSlotCount: 612,
      robotCount: 7_344,
      buildingCount: 2_448,
      drawCalls: 3,
    });
    expect(points.geometry.drawRange.count).toBe(7_344);
    batch.dispose();
  });

  it('fails fast on frames that reference unknown slots or duplicate entities', () => {
    const batch = new PreviewBatch([slot('g1', 'east', 'm1', 1)]);
    const valid: RoundPreviewEntity = {
      key: 'g1',
      entityId: 1,
      kind: 'robot',
      team: 'red',
      x: 0,
      y: 0,
      z: 0,
      defeated: false,
    };

    expect(() => batch.setFrame({ timeMs: 0, entities: [{ ...valid, key: 'missing' }] })).toThrow(
      /unknown slot/
    );
    expect(() => batch.setFrame({ timeMs: 0, entities: [valid, valid] })).toThrow(/Duplicate/);
    batch.dispose();
  });

  it('rejects entity identity drift after the first stable frame', () => {
    const batch = new PreviewBatch([slot('g1', 'east', 'm1', 1)]);
    const entity: RoundPreviewEntity = {
      key: 'g1',
      entityId: 1,
      kind: 'robot',
      team: 'red',
      x: 0,
      y: 0,
      z: 0,
      defeated: false,
    };
    batch.setFrame({ timeMs: 0, entities: [entity] });

    expect(() =>
      batch.setFrame({ timeMs: 100, entities: [{ ...entity, entityId: 2 }] })
    ).toThrow(/identity changed/);
    batch.dispose();
  });
});

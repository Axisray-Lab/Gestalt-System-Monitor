import {
  loadOverviewTrack,
  readOverviewSample,
  type OverviewEntitySample,
  type OverviewTrack,
} from '@/feed/overviewTrack';
import type {
  OverviewTrackDescriptor,
  StaticReplayRoundDescriptor,
} from '@/feed/staticReplayCatalog';
import type { DioramaScene } from './DioramaScene';
import type {
  RoundPreviewEntity,
  RoundPreviewFrame,
  RoundPreviewSlot,
} from './PreviewBatch';

const PREVIEW_TICK_MS = 100;

interface TrackRoundRef {
  track: OverviewTrack;
  round: OverviewTrack['rounds'][number];
}

/**
 * Bridges the immutable 1 Hz official overview tracks into the scene-level
 * preview batch. One timer drives all 613 games; entity objects are allocated
 * once and mutated in stable identity order for the 10 Hz interpolation ticks.
 */
export class RoundPreviewPlayback {
  private readonly descriptorByKey = new Map<string, StaticReplayRoundDescriptor>();
  private readonly roundByKey = new Map<string, TrackRoundRef>();
  private readonly entities: RoundPreviewEntity[] = [];
  private readonly leftSample: OverviewEntitySample = { x: 0, y: 0, z: 0, defeated: false };
  private readonly rightSample: OverviewEntitySample = { x: 0, y: 0, z: 0, defeated: false };
  private readonly frame: RoundPreviewFrame = { timeMs: 0, entities: this.entities };
  private readonly controller = new AbortController();
  private timer: number | null = null;
  private startedAt = performance.now();
  private started = false;
  private ready = false;
  private disposed = false;

  constructor(
    private readonly scene: DioramaScene,
    private readonly rounds: readonly StaticReplayRoundDescriptor[],
    private readonly shards: readonly OverviewTrackDescriptor[],
    private readonly databaseSha256: string
  ) {
    if (rounds.length === 0) {
      throw new Error('Round preview playback requires at least one round');
    }
    for (const round of rounds) {
      if (this.descriptorByKey.has(round.key)) {
        throw new Error(`Duplicate round preview descriptor: ${round.key}`);
      }
      this.descriptorByKey.set(round.key, round);
    }
    const slots: RoundPreviewSlot[] = rounds.map((round) => ({
      key: round.key,
      regionKey: round.regionKey,
      seriesKey: round.seriesKey,
      roundNumber: round.roundNumber,
      label: `M${String(round.matchNumber).padStart(3, '0')} · G${round.roundNumber}`,
    }));
    scene.setRoundPreviewLayout(slots);
  }

  async start(): Promise<void> {
    this.assertAlive();
    if (this.started) {
      throw new Error('Round preview playback was started more than once');
    }
    this.started = true;
    const descriptorsByRegion = new Map<string, OverviewTrackDescriptor>();
    for (const shard of this.shards) {
      if (descriptorsByRegion.has(shard.regionKey)) {
        throw new Error(`Duplicate overview shard for ${shard.regionKey}`);
      }
      descriptorsByRegion.set(shard.regionKey, shard);
    }
    const regionKeys = new Set(this.rounds.map((round) => round.regionKey));
    if (
      descriptorsByRegion.size !== regionKeys.size ||
      [...regionKeys].some((key) => !descriptorsByRegion.has(key))
    ) {
      throw new Error('Overview shard regions do not exactly cover the configured rounds');
    }

    const tracks = await Promise.all(
      [...descriptorsByRegion.values()].map((descriptor) =>
        loadOverviewTrack(
          descriptor,
          this.rounds.filter((round) => round.regionKey === descriptor.regionKey),
          this.databaseSha256,
          this.controller.signal
        )
      )
    );
    this.assertAlive();
    for (const track of tracks) {
      for (const round of track.rounds) {
        const key = round.descriptor.key;
        if (this.roundByKey.has(key)) throw new Error(`Duplicate overview round payload: ${key}`);
        this.roundByKey.set(key, { track, round });
      }
    }
    if (
      this.roundByKey.size !== this.rounds.length ||
      this.rounds.some((round) => !this.roundByKey.has(round.key))
    ) {
      throw new Error('Overview payload rounds do not exactly cover the configured catalog');
    }
    for (const descriptor of this.rounds) {
      const ref = this.roundByKey.get(descriptor.key);
      if (!ref) throw new Error(`Overview round disappeared during setup: ${descriptor.key}`);
      for (const robotId of ref.round.robotIds) {
        this.entities.push({
          key: descriptor.key,
          entityId: robotId,
          kind: 'robot',
          team: robotId >= 100 ? 'blue' : 'red',
          x: 0,
          y: 0,
          z: 0,
          defeated: false,
        });
      }
    }
    this.ready = true;
    this.update(performance.now());
    this.timer = window.setInterval(() => this.update(performance.now()), PREVIEW_TICK_MS);
  }

  isReady(): boolean {
    return this.ready;
  }

  hasRound(key: string): boolean {
    return this.descriptorByKey.has(key);
  }

  positionMs(key: string, now = performance.now()): number {
    const descriptor = this.descriptorByKey.get(key);
    if (!descriptor) throw new Error(`Unknown overview round: ${key}`);
    return Math.max(0, now - this.startedAt) % descriptor.durationMs;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort('Round preview playback disposed');
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.scene.clearRoundPreviews();
    this.roundByKey.clear();
    this.entities.length = 0;
    this.ready = false;
  }

  private update(now: number): void {
    this.assertAlive();
    if (!this.ready) throw new Error('Round preview update ran before tracks were ready');
    let entityIndex = 0;
    for (const descriptor of this.rounds) {
      const ref = this.roundByKey.get(descriptor.key);
      if (!ref) throw new Error(`Overview round disappeared during playback: ${descriptor.key}`);
      const localMs = this.positionMs(descriptor.key, now);
      const samplePosition = localMs / 1000;
      const leftIndex = Math.min(ref.round.sampleCount - 1, Math.floor(samplePosition));
      const rightIndex = Math.min(ref.round.sampleCount - 1, leftIndex + 1);
      const alpha = rightIndex === leftIndex ? 0 : samplePosition - leftIndex;
      for (let robotIndex = 0; robotIndex < ref.round.robotIds.length; robotIndex += 1) {
        readOverviewSample(ref.track, ref.round, leftIndex, robotIndex, this.leftSample);
        readOverviewSample(ref.track, ref.round, rightIndex, robotIndex, this.rightSample);
        const entity = this.entities[entityIndex];
        if (
          !entity ||
          entity.key !== descriptor.key ||
          entity.entityId !== ref.round.robotIds[robotIndex]
        ) {
          throw new Error(`Overview entity order drifted at ${descriptor.key}/${robotIndex}`);
        }
        const ueX = this.leftSample.x + (this.rightSample.x - this.leftSample.x) * alpha;
        const ueY = this.leftSample.y + (this.rightSample.y - this.leftSample.y) * alpha;
        const ueZ = this.leftSample.z + (this.rightSample.z - this.leftSample.z) * alpha;
        // Existing UE -> Three mapping, inlined to keep this 10 Hz hot path allocation-free.
        entity.x = -ueX * 0.01;
        entity.y = ueZ * 0.01;
        entity.z = -ueY * 0.01;
        entity.defeated = this.leftSample.defeated;
        entityIndex += 1;
      }
    }
    if (entityIndex !== this.entities.length) {
      throw new Error(`Overview entity count drifted: ${entityIndex}/${this.entities.length}`);
    }
    const elapsedMs = Math.max(0, now - this.startedAt);
    this.frame.timeMs = elapsedMs;
    this.scene.setRoundPreviewClock(elapsedMs);
    this.scene.setRoundPreviewFrame(this.frame);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('Round preview playback has been disposed');
  }
}

import type { MapWireframe, WorldSnapshot } from '@gsm/protocol';
import { AttributeStore } from './attributeStore';
import {
  parseRecordedReplay,
  RECORDED_REPLAY_TICK_MS,
  replayAssetUrl,
  type RecordedReplay,
} from './recordedReplay';
import type { StaticReplayRoundDescriptor } from './staticReplayCatalog';
import type {
  FeedSource,
  FeedStatus,
  ReplayPlaybackState,
} from './types';

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This browser does not support replay integrity verification');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function loadRecordedReplay(
  descriptor: StaticReplayRoundDescriptor,
  signal: AbortSignal
): Promise<RecordedReplay> {
  const url = replayAssetUrl(
    descriptor.assetPath,
    import.meta.env.BASE_URL,
    document.baseURI
  );
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${url}`);
  }
  if (descriptor.encoding !== 'gzip') {
    throw new Error(`Unsupported static replay encoding: ${String(descriptor.encoding)}`);
  }
  if (response.body === null) {
    throw new Error(`Response body is missing while loading ${url}`);
  }
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new Error('This browser does not support gzip replay decompression');
  }
  const compressed = await new Response(response.body).arrayBuffer();
  if (compressed.byteLength !== descriptor.compressedBytes) {
    throw new Error(
      `Compressed byte count mismatch for ${descriptor.key}: ` +
        `${compressed.byteLength} != ${descriptor.compressedBytes}`
    );
  }
  const digest = await sha256Hex(compressed);
  if (digest !== descriptor.sha256) {
    throw new Error(`SHA-256 mismatch for ${descriptor.key}: ${digest} != ${descriptor.sha256}`);
  }
  const decompressed = new Blob([compressed]).stream().pipeThrough(
    new DecompressionStream('gzip'),
    { signal }
  );
  const json = await new Response(decompressed).text();
  const replay = parseRecordedReplay(JSON.parse(json) as unknown);
  if (
    replay.frameCount !== descriptor.assetFrameCount ||
    replay.durationMs !== descriptor.assetDurationMs
  ) {
    throw new Error(
      `Replay metadata mismatch for ${descriptor.key}: ` +
        `frames ${replay.frameCount}/${descriptor.assetFrameCount}, ` +
        `duration ${replay.durationMs}/${descriptor.assetDurationMs}`
    );
  }
  return replay;
}

const REPLAY_ASSET_CACHE_LIMIT = 2;

interface ReplayAssetCacheEntry {
  controller: AbortController;
  promise: Promise<RecordedReplay>;
  replay: RecordedReplay | null;
  users: number;
  lastUsed: number;
}

interface ReplayAssetLease {
  promise: Promise<RecordedReplay>;
  release(): void;
}

const replayAssetCache = new Map<string, ReplayAssetCacheEntry>();
let replayAssetUseSequence = 0;

function replayAssetCacheKey(descriptor: StaticReplayRoundDescriptor): string {
  return `${descriptor.assetKey}:${descriptor.sha256}`;
}

function trimReplayAssetCache(maxSize = REPLAY_ASSET_CACHE_LIMIT): void {
  const idle = [...replayAssetCache.entries()]
    .filter(([, entry]) => entry.users === 0 && entry.replay !== null)
    .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  while (replayAssetCache.size > maxSize && idle.length > 0) {
    const [key] = idle.shift()!;
    replayAssetCache.delete(key);
  }
}

function acquireReplayAsset(descriptor: StaticReplayRoundDescriptor): ReplayAssetLease {
  const key = replayAssetCacheKey(descriptor);
  let entry = replayAssetCache.get(key);
  if (!entry) {
    trimReplayAssetCache(REPLAY_ASSET_CACHE_LIMIT - 1);
    const controller = new AbortController();
    entry = {
      controller,
      replay: null,
      users: 0,
      lastUsed: ++replayAssetUseSequence,
      promise: Promise.resolve(null as unknown as RecordedReplay),
    };
    const created = entry;
    created.promise = loadRecordedReplay(descriptor, controller.signal)
      .then((replay) => {
        created.replay = replay;
        trimReplayAssetCache();
        return replay;
      })
      .catch((error: unknown) => {
        if (replayAssetCache.get(key) === created) replayAssetCache.delete(key);
        throw error;
      });
    replayAssetCache.set(key, created);
  }
  entry.users += 1;
  entry.lastUsed = ++replayAssetUseSequence;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry!.users -= 1;
      if (entry!.users < 0) {
        throw new Error(`Replay asset cache reference count underflow: ${key}`);
      }
      entry!.lastUsed = ++replayAssetUseSequence;
      queueMicrotask(() => {
        const current = replayAssetCache.get(key);
        if (current !== entry || current.users !== 0) return;
        if (current.replay === null) {
          current.controller.abort(`No replay feed still needs ${descriptor.assetKey}`);
          replayAssetCache.delete(key);
          return;
        }
        trimReplayAssetCache();
      });
    },
  };
}

export function createMockFeed(descriptor: StaticReplayRoundDescriptor): FeedSource {
  if (
    !Number.isSafeInteger(descriptor.durationMs) ||
    descriptor.durationMs <= 0 ||
    descriptor.endMs - descriptor.startMs !== descriptor.durationMs ||
    descriptor.frameStartIndex * RECORDED_REPLAY_TICK_MS !== descriptor.startMs ||
    descriptor.frameCountInRound !== descriptor.frameCount ||
    descriptor.frameStartIndex + descriptor.frameCountInRound > descriptor.assetFrameCount
  ) {
    throw new Error(`Static replay round window is invalid: ${descriptor.key}`);
  }
  let store = new AttributeStore();
  let replay: RecordedReplay | null = null;
  let replayIndex = descriptor.frameStartIndex;
  let previousReplayT = -1;
  let timer: number | null = null;
  let lease: ReplayAssetLease | null = null;
  let startToken = 0;
  let paused = false;
  let playbackPositionMs = 0;
  let playbackCycle = 0;
  let appliedPlaybackCycle = 0;
  let playbackAnchoredAt = performance.now();
  let mapCb: ((map: MapWireframe) => void) | null = null;
  let snapshotCb: ((snapshot: WorldSnapshot) => void) | null = null;
  let statusCb: ((status: FeedStatus) => void) | null = null;
  let playbackCb: ((state: ReplayPlaybackState) => void) | null = null;
  let playbackDiscontinuityCb: (() => void) | null = null;

  const roundFrameEnd = descriptor.frameStartIndex + descriptor.frameCountInRound;

  function playbackTotalAt(now = performance.now()): number {
    return (
      playbackCycle * descriptor.durationMs +
      playbackPositionMs +
      (paused ? 0 : now - playbackAnchoredAt)
    );
  }

  function playbackAt(now = performance.now()): number {
    return playbackTotalAt(now) % descriptor.durationMs;
  }

  function anchorPlayback(positionMs: number, now = performance.now()): void {
    playbackPositionMs = positionMs;
    playbackAnchoredAt = now;
  }

  function emitPlayback(now = performance.now()): void {
    playbackCb?.({
      paused,
      positionMs: playbackAt(now),
      durationMs: descriptor.durationMs,
    });
  }

  function resetRoundFold(): void {
    store = new AttributeStore();
    replayIndex = descriptor.frameStartIndex;
    previousReplayT = -1;
  }

  function applyThrough(replayT: number): void {
    if (!replay) return;
    const absoluteT = descriptor.startMs + replayT;
    while (
      replayIndex < roundFrameEnd &&
      replay.frames[replayIndex].t <= absoluteT
    ) {
      const frame = replay.frames[replayIndex];
      store.applyResult(frame.result, frame.t);
      replayIndex += 1;
    }
    const snapshot = store.toSnapshot(absoluteT);
    snapshot.t = replayT;
    snapshotCb?.(snapshot);
  }

  function tick(): void {
    if (!replay) return;
    if (paused) return;
    const now = performance.now();
    const total = playbackTotalAt(now);
    const cycle = Math.floor(total / descriptor.durationMs);
    const replayT = total % descriptor.durationMs;
    if (cycle !== appliedPlaybackCycle || replayT < previousReplayT) {
      playbackDiscontinuityCb?.();
      resetRoundFold();
    }
    applyThrough(replayT);
    previousReplayT = replayT;
    appliedPlaybackCycle = cycle;
    emitPlayback(now);
  }

  return {
    label: descriptor.label,
    playback: {
      onState: cb => {
        playbackCb = cb;
        emitPlayback();
      },
      onDiscontinuity: cb => {
        playbackDiscontinuityCb = cb;
      },
      setPaused: nextPaused => {
        if (paused === nextPaused) return;
        const now = performance.now();
        const total = playbackTotalAt(now);
        const cycle = Math.floor(total / descriptor.durationMs);
        const position = total % descriptor.durationMs;
        playbackCycle = cycle;
        paused = nextPaused;
        anchorPlayback(position, now);
        emitPlayback(now);
      },
      seek: positionMs => {
        if (
          !Number.isFinite(positionMs) ||
          positionMs < 0 ||
          positionMs >= descriptor.durationMs
        ) {
          throw new Error(
            `Replay seek is outside ${descriptor.key}: ${positionMs}/${descriptor.durationMs}`
          );
        }
        const now = performance.now();
        const cycle = Math.floor(playbackTotalAt(now) / descriptor.durationMs);
        playbackCycle = cycle;
        anchorPlayback(positionMs, now);
        if (replay) {
          playbackDiscontinuityCb?.();
          if (cycle !== appliedPlaybackCycle || positionMs < previousReplayT) resetRoundFold();
          applyThrough(positionMs);
          previousReplayT = positionMs;
          appliedPlaybackCycle = cycle;
        }
        emitPlayback(now);
      },
    },
    onMap: cb => (mapCb = cb),
    onSnapshot: cb => (snapshotCb = cb),
    onStatus: cb => (statusCb = cb),
    setActive: () => {},
    start: () => {
      if (timer != null || lease != null) return;
      const token = ++startToken;
      const acquired = acquireReplayAsset(descriptor);
      lease = acquired;
      statusCb?.('connecting');
      void acquired.promise
        .then(loaded => {
          if (token !== startToken || lease !== acquired) return;
          replay = loaded;
          resetRoundFold();
          statusCb?.('open');
          mapCb?.(loaded.map);
          const now = performance.now();
          const total = playbackTotalAt(now);
          const cycle = Math.floor(total / descriptor.durationMs);
          const position = total % descriptor.durationMs;
          appliedPlaybackCycle = cycle;
          applyThrough(position);
          previousReplayT = position;
          emitPlayback(now);
          timer = window.setInterval(tick, RECORDED_REPLAY_TICK_MS);
        })
        .catch((error: unknown) => {
          if (token !== startToken || lease !== acquired) return;
          acquired.release();
          lease = null;
          replay = null;
          console.error(`[static replay:${descriptor.key}] load failed`, error);
          statusCb?.('error');
        });
    },
    close: () => {
      startToken += 1;
      lease?.release();
      lease = null;
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
      replay = null;
      resetRoundFold();
      statusCb?.('closed');
    },
  };
}

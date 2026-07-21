import type { MapWireframe, WorldSnapshot } from '@gsm/protocol';
import { AttributeStore } from './attributeStore';
import {
  parseRecordedReplay,
  RECORDED_REPLAY_TICK_MS,
  replayAssetUrl,
  type RecordedReplay,
} from './recordedReplay';
import type { StaticReplayDescriptor } from './staticReplayCatalog';
import type { FeedSource, FeedStatus } from './types';

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
  descriptor: StaticReplayDescriptor,
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
    replay.frameCount !== descriptor.frameCount ||
    replay.durationMs !== descriptor.durationMs
  ) {
    throw new Error(
      `Replay metadata mismatch for ${descriptor.key}: ` +
        `frames ${replay.frameCount}/${descriptor.frameCount}, ` +
        `duration ${replay.durationMs}/${descriptor.durationMs}`
    );
  }
  return replay;
}

export function createMockFeed(descriptor: StaticReplayDescriptor): FeedSource {
  let store = new AttributeStore();
  let replay: RecordedReplay | null = null;
  let replayStartedAt = 0;
  let replayIndex = 0;
  let previousReplayT = 0;
  let timer: number | null = null;
  let loadController: AbortController | null = null;
  let startToken = 0;
  let mapCb: ((map: MapWireframe) => void) | null = null;
  let snapshotCb: ((snapshot: WorldSnapshot) => void) | null = null;
  let statusCb: ((status: FeedStatus) => void) | null = null;

  function applyThrough(replayT: number): void {
    if (!replay) return;
    while (
      replayIndex < replay.frames.length &&
      replay.frames[replayIndex].t <= replayT
    ) {
      store.applyResult(replay.frames[replayIndex].result);
      replayIndex += 1;
    }
    snapshotCb?.(store.toSnapshot());
  }

  function tick(): void {
    if (!replay) return;
    const replayT = (performance.now() - replayStartedAt) % replay.durationMs;
    if (replayT < previousReplayT) {
      store = new AttributeStore();
      replayIndex = 0;
    }
    applyThrough(replayT);
    previousReplayT = replayT;
  }

  return {
    label: descriptor.label,
    onMap: cb => (mapCb = cb),
    onSnapshot: cb => (snapshotCb = cb),
    onStatus: cb => (statusCb = cb),
    setActive: () => {},
    start: () => {
      if (timer != null || loadController != null) return;
      const token = ++startToken;
      const controller = new AbortController();
      loadController = controller;
      statusCb?.('connecting');
      void loadRecordedReplay(descriptor, controller.signal)
        .then(loaded => {
          if (token !== startToken || controller.signal.aborted) return;
          loadController = null;
          replay = loaded;
          store = new AttributeStore();
          replayIndex = 0;
          previousReplayT = 0;
          replayStartedAt = performance.now();
          statusCb?.('open');
          mapCb?.(loaded.map);
          applyThrough(0);
          timer = window.setInterval(tick, RECORDED_REPLAY_TICK_MS);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || token !== startToken) return;
          loadController = null;
          replay = null;
          console.error(`[static replay:${descriptor.key}] load failed`, error);
          statusCb?.('error');
        });
    },
    close: () => {
      startToken += 1;
      loadController?.abort();
      loadController = null;
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
      replay = null;
      replayIndex = 0;
      statusCb?.('closed');
    },
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRecordedReplay } from './mockFeed';
import type { StaticReplayDescriptor } from './staticReplayCatalog';

const descriptorBase: Omit<StaticReplayDescriptor, 'compressedBytes' | 'sha256'> = {
  key: 'rmuc2026-east-m001',
  label: 'M001',
  assetPath: 'replays/rmuc2026-regionals/east/m001.json.gzip',
  encoding: 'gzip',
  regionKey: 'east',
  regionLabel: '东部赛区',
  matchNumber: 1,
  roundCount: 1,
  redSchool: '红方学校',
  blueSchool: '蓝方学校',
  frameCount: 1,
  durationMs: 100,
  competitionKey: 'rmuc2026',
  competitionLabel: 'RMUC 2026',
  mapKey: 'rmuc2026',
  mapLabel: 'RMUC 2026',
};

const replay = {
  schema: 'gsm-watch-replay/2',
  frameCount: 1,
  durationMs: 100,
  map: { mapId: 'RMUC2026', lines: [] },
  frames: [
    {
      t: 0,
      result: {
        watch_attribute_maps_results: [
          { sync_type: 0, attribute_map_id: 1, attributes: {} },
        ],
      },
    },
  ],
};

async function gzip(text: string): Promise<ArrayBuffer> {
  const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(compressed).arrayBuffer();
}

async function descriptorFor(bytes: ArrayBuffer): Promise<StaticReplayDescriptor> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return { ...descriptorBase, compressedBytes: bytes.byteLength, sha256 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('static gzip replay loading', () => {
  it('explicitly decompresses gzip before parsing the replay JSON', async () => {
    const bytes = await gzip(JSON.stringify(replay));
    const descriptor = await descriptorFor(bytes);
    vi.stubGlobal('document', { baseURI: 'https://example.test/monitor/index.html' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })));

    const loaded = await loadRecordedReplay(descriptor, new AbortController().signal);

    expect(loaded.schema).toBe('gsm-watch-replay/2');
    expect(loaded.frameCount).toBe(1);
  });

  it('does not fall back to parsing an uncompressed JSON response', async () => {
    const bytes = await new Blob([JSON.stringify(replay)]).arrayBuffer();
    const descriptor = await descriptorFor(bytes);
    vi.stubGlobal('document', { baseURI: 'https://example.test/monitor/index.html' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }))
    );

    await expect(
      loadRecordedReplay(descriptor, new AbortController().signal)
    ).rejects.toThrow();
  });

  it('fails immediately when the response has no body', async () => {
    const descriptor = { ...descriptorBase, compressedBytes: 1, sha256: 'a'.repeat(64) };
    vi.stubGlobal('document', { baseURI: 'https://example.test/monitor/index.html' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    await expect(
      loadRecordedReplay(descriptor, new AbortController().signal)
    ).rejects.toThrow(/body is missing/);
  });

  it('rejects a valid gzip payload whose replay metadata disagrees with the catalog', async () => {
    const bytes = await gzip(JSON.stringify(replay));
    const descriptor = { ...(await descriptorFor(bytes)), frameCount: 2 };
    vi.stubGlobal('document', { baseURI: 'https://example.test/monitor/index.html' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })));

    await expect(
      loadRecordedReplay(descriptor, new AbortController().signal)
    ).rejects.toThrow(/metadata mismatch/);
  });
});

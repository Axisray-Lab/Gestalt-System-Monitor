#!/usr/bin/env node
// Record a player-observable attribute-map stream into a browser-playable replay.
// Usage:
//   node packages/agent/probe/record-replay.mjs --seconds 45
//   node packages/agent/probe/record-replay.mjs --url ws://127.0.0.1:8128 --seconds 45

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';

const METHOD_WATCH_ATTRIBUTE_MAPS = 'attribute.watchAttributeMaps';
const METHOD_WATCH_ATTRIBUTE_MAPS_RESULT = 'watchAttributeMaps.result';
const WATCH_CONTINUOUS = 2;

const ATTR = {
  PlayerID_0: 0,
  PlayerID_MAX: 100000,
  PlayerBattleAttributeMapID: 1000001,
  G_BaseId_0: 80001000,
  G_BaseId_MAX: 80001999,
  G_OutpostId_0: 80002000,
  G_OutpostId_MAX: 80002999,
  G_BuffStationId_0: 80004000,
  G_BuffStationId_MAX: 80004999,
};

const DEFAULT_WATCH_MAP_IDS = Array.from({ length: 256 }, (_, i) => i + 1);
const DEFAULT_OUT = 'packages/web/public/replays/rmuc2026ai-loop.json';
const RMUC_FIELD_HALF_X_CM = 836;
const RMUC_FIELD_HALF_Y_CM = 1500;

const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);
const seconds = Number(arg('--seconds', '45'));
const waitSeconds = Number(arg('--wait', '90'));
const agentUrl = arg('--agent', 'ws://127.0.0.1:7788');
const directUrl = arg('--url');
const outFile = resolve(arg('--out', DEFAULT_OUT));
const quiet = has('--quiet');

function log(...parts) {
  if (!quiet) console.log('[record-replay]', ...parts);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseMapId(value) {
  if (value == null || value === '') return undefined;
  const asNumber = Number(value);
  return Number.isInteger(asNumber) ? asNumber : value;
}

function isNotification(msg) {
  return msg?.type === 0 && typeof msg.method === 'string';
}

function watchPayload(ids, reqId) {
  return JSON.stringify({
    type: 0,
    id: reqId,
    method: METHOD_WATCH_ATTRIBUTE_MAPS,
    params: { attribute_map_ids: ids, watch_type: WATCH_CONTINUOUS },
  });
}

function addRangeValues(attributes, first, last, out) {
  for (const [k, v] of Object.entries(attributes ?? {})) {
    const attr = Number(k);
    if (attr < first || attr > last) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.add(Math.round(v));
  }
}

function referencedMapIds(result) {
  const ids = new Set();
  for (const update of result?.watch_attribute_maps_results ?? []) {
    const attributes = update.attributes ?? {};
    const battleMapId = attributes[String(ATTR.PlayerBattleAttributeMapID)];
    if (typeof battleMapId === 'number' && Number.isFinite(battleMapId) && battleMapId > 0) {
      ids.add(Math.round(battleMapId));
    }

    addRangeValues(attributes, ATTR.G_BaseId_0, ATTR.G_BaseId_MAX, ids);
    addRangeValues(attributes, ATTR.G_OutpostId_0, ATTR.G_OutpostId_MAX, ids);
    addRangeValues(attributes, ATTR.G_BuffStationId_0, ATTR.G_BuffStationId_MAX, ids);

    const hasGlobalIds = Object.keys(attributes).some((k) => {
      const attr = Number(k);
      return (
        (attr >= ATTR.G_BaseId_0 && attr <= ATTR.G_BaseId_MAX) ||
        (attr >= ATTR.G_OutpostId_0 && attr <= ATTR.G_OutpostId_MAX) ||
        (attr >= ATTR.G_BuffStationId_0 && attr <= ATTR.G_BuffStationId_MAX)
      );
    });
    if (!hasGlobalIds) continue;
    addRangeValues(attributes, ATTR.PlayerID_0, ATTR.PlayerID_MAX, ids);
  }
  return ids;
}

async function discoverProcess() {
  if (directUrl) return { wsUrl: directUrl, mapId: parseMapId(arg('--mapId')) };

  log('waiting for discovery agent process list...');
  return await new Promise((resolveDiscover, rejectDiscover) => {
    const ws = new WebSocket(agentUrl);
    const timer = setTimeout(() => {
      ws.close();
      rejectDiscover(new Error(`no live match discovered within ${waitSeconds}s`));
    }, waitSeconds * 1000);

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const process = msg?.kind === 'processes' ? msg.processes?.[0] : null;
      if (!process?.wsUrl) return;
      clearTimeout(timer);
      ws.close();
      resolveDiscover({
        wsUrl: process.wsUrl,
        mapId: parseMapId(arg('--mapId', process.mapId)),
      });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      rejectDiscover(err);
    });
  });
}

async function record({ wsUrl, mapId }) {
  const frames = [];
  const watched = new Set();
  let reqId = 1;
  let opened = false;
  let startedAt = 0;

  const ws = new WebSocket(wsUrl);

  function watch(ids) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const fresh = [...ids]
      .map((id) => Math.round(id))
      .filter((id) => Number.isFinite(id) && id > 0 && !watched.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) watched.add(id);
    ws.send(watchPayload(fresh, reqId++));
  }

  await new Promise((resolveOpen, rejectOpen) => {
    ws.on('open', () => {
      opened = true;
      startedAt = Date.now();
      log('open', wsUrl);
      watch(DEFAULT_WATCH_MAP_IDS);
      resolveOpen();
    });
    ws.on('error', rejectOpen);
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!isNotification(msg) || msg.method !== METHOD_WATCH_ATTRIBUTE_MAPS_RESULT) return;
    const result = msg.params;
    frames.push({ t: Date.now() - startedAt, result });
    watch(referencedMapIds(result));
  });

  await sleep(Math.max(1, seconds) * 1000);
  ws.close();
  if (!opened || frames.length === 0) throw new Error('recording produced no telemetry frames');

  const firstT = frames[0].t;
  for (const frame of frames) frame.t -= firstT;
  const durationMs = Math.max(...frames.map((f) => f.t), 1);
  return {
    schema: 'gsm-watch-replay/1',
    generatedAt: new Date().toISOString(),
    durationMs,
    frameCount: frames.length,
    map: {
      mapId: mapId ?? 'RMUC2026AI',
      lines: [],
      bounds: {
        min: { x: -RMUC_FIELD_HALF_X_CM, y: -RMUC_FIELD_HALF_Y_CM, z: 0 },
        max: { x: RMUC_FIELD_HALF_X_CM, y: RMUC_FIELD_HALF_Y_CM, z: 0 },
      },
    },
    frames,
  };
}

try {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--seconds must be > 0');
  const process = await discoverProcess();
  const replay = await record(process);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(replay)}\n`, 'utf8');
  log(`wrote ${replay.frameCount} frames / ${(replay.durationMs / 1000).toFixed(1)}s -> ${outFile}`);
} catch (err) {
  console.error('[record-replay] ERROR:', err?.message ?? err);
  process.exitCode = 1;
}

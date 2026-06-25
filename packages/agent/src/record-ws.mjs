#!/usr/bin/env node
/**
 * WebSocket Trace Recorder — connects to a match's WebSocket, subscribes to
 * watchAttributeMaps, records every frame as compact-delta, and writes
 * per-match trace files (same format as trace-replayer consumes).
 *
 * Usage:
 *   node record-ws.mjs --url ws://127.0.0.1:9240 --count 5 --out traces/multi-5
 *   node record-ws.mjs --agent ws://localhost:7791 --count 15 --out traces/multi-15
 *
 * When --agent is given, discovers matches from the agent and records each one.
 * When --url is given, records from a single match WebSocket (expects auto-restart).
 */

import { WebSocket } from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Protocol constants (mirrored to avoid TS import issues in plain Node)
const METHOD_WATCH_ATTRIBUTE_MAPS = 'attribute.watchAttributeMaps';
const METHOD_WATCH_ATTRIBUTE_MAPS_RESULT = 'watchAttributeMaps.result';

const G_CUR_GAME_TIME = 80000002;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  return {
    url: get('--url'),
    agent: get('--agent'),
    count: parseInt(get('--count') ?? '1', 10),
    out: get('--out') ?? 'traces/recorded',
    matchTimeoutMin: parseInt(get('--match-timeout-min') ?? '15', 10),
    verbose: args.includes('--verbose'),
  };
}

function attrsGet(attrs, id, def = 0) {
  if (Array.isArray(attrs)) {
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === id) return attrs[i + 1];
  } else if (typeof attrs === 'object' && attrs !== null) {
    if (attrs[id] !== undefined) return attrs[id];
  }
  return def;
}

function attrsToFlat(obj) {
  if (Array.isArray(obj)) return obj;
  const flat = [];
  if (typeof obj === 'object' && obj !== null) {
    for (const [k, v] of Object.entries(obj)) flat.push(Number(k), Number(v));
  }
  return flat;
}

function attrsDiff(prev, cur) {
  if (!prev) return cur; // first frame
  const diff = [];
  for (let i = 0; i < cur.length; i += 2) {
    const id = cur[i], val = cur[i + 1];
    let found = false;
    for (let j = 0; j < prev.length; j += 2) {
      if (prev[j] === id) { if (prev[j + 1] !== val) diff.push(id, val); found = true; break; }
    }
    if (!found) diff.push(id, val);
  }
  return diff.length > 0 ? diff : null;
}

function matchWinner(summaryFrames) {
  // Find base HP from last frame
  let redBaseHp = 300, blueBaseHp = 300;
  for (const frame of [...summaryFrames].reverse()) {
    for (const [mid, flat] of frame) {
      if (mid === 80001000) redBaseHp = attrsGet(flat, 10000003, redBaseHp);
      if (mid === 80001001) blueBaseHp = attrsGet(flat, 10000003, blueBaseHp);
    }
    if (redBaseHp !== 300 || blueBaseHp !== 300) break;
  }
  if (redBaseHp <= 0 && blueBaseHp > 0) return 'team1'; // blue won
  if (blueBaseHp <= 0 && redBaseHp > 0) return 'team0'; // red won
  return 'unknown';
}

async function main() {
  const cfg = parseArgs();
  console.log(`[rec-ws] target: ${cfg.count} matches → ${cfg.out}`);

  if (!cfg.url && !cfg.agent) {
    console.error('[rec-ws] need --url or --agent');
    process.exit(1);
  }

  const urls = [];
  if (cfg.url) {
    urls.push(cfg.url);
  } else if (cfg.agent) {
    // Discover matches from agent
    console.log(`[rec-ws] discovering from ${cfg.agent}`);
    const resp = await fetch(`${cfg.agent.replace('ws://', 'http://')}/processes`);
    const data = await resp.json();
    urls.push(...data.processes.map(p => p.wsUrl));
    console.log(`[rec-ws] found ${urls.length} matches`);
  }

  if (urls.length === 0) {
    console.error('[rec-ws] no matches found');
    process.exit(1);
  }

  await mkdir(cfg.out, { recursive: true });

  // Record from each match URL
  let globalMatchIdx = 0;
  const allMatchSummaries = [];

  for (const url of urls) {
    console.log(`[rec-ws] connecting to ${url}`);
    const frames = await recordOne(url, cfg);
    console.log(`[rec-ws] recorded ${frames.length} frames from ${url}`);

    // Split frames into matches by gt drops
    const matches = splitMatches(frames);
    console.log(`[rec-ws] split into ${matches.length} matches`);

    for (const match of matches) {
      globalMatchIdx++;
      const iterName = `iter-${String(globalMatchIdx).padStart(3, '0')}`;
      const tp = path.join(cfg.out, `${iterName}.trace.json`);

      const winner = matchWinner(match.frames);
      const trace = {
        v: 3,
        src: 'ws-record',
        fmt: 'compact-delta',
        mapId: 9,
        frameCount: match.frames.length,
        durMs: match.durMs,
        gtMs: match.gtMs,
        summary: { winner },
        frames: match.frames,
      };

      await writeFile(tp, JSON.stringify(trace));
      const mb = (Buffer.byteLength(JSON.stringify(trace)) / 1e6).toFixed(1);
      console.log(`[rec-ws]   ${iterName}: ${match.frames.length} frames, ${mb} MB, winner=${winner}`);
      allMatchSummaries.push({ index: globalMatchIdx, frames: match.frames.length, winner });

      if (globalMatchIdx >= cfg.count) break;
    }

    if (globalMatchIdx >= cfg.count) break;
  }

  // Write summary
  const summary = {
    schema: 'ws-record-summary/1',
    matchCount: allMatchSummaries.length,
    matches: allMatchSummaries,
  };
  await writeFile(path.join(cfg.out, 'summary.json'), JSON.stringify(summary));
  console.log(`[rec-ws] DONE: ${allMatchSummaries.length} matches → ${cfg.out}`);
}

async function recordOne(url, cfg) {
  return new Promise((resolve, reject) => {
    const frames = [];
    let reqId = 1;
    const ws = new WebSocket(url);
    const deadline = Date.now() + cfg.count * cfg.matchTimeoutMin * 60 * 1000;
    let timeout;

    ws.on('open', () => {
      console.log(`[rec-ws]   connected, subscribing...`);
      // Subscribe to attribute maps 1-256 (covers all vehicles, buildings, global)
      const mapIds = Array.from({ length: 256 }, (_, i) => i + 1);
      ws.send(JSON.stringify({
        type: 0,
        id: reqId++,
        method: METHOD_WATCH_ATTRIBUTE_MAPS,
        params: { attribute_map_ids: mapIds, watch_type: 1 }, // 1 = WatchContinuous
      }));
      timeout = setTimeout(() => {
        console.log(`[rec-ws]   timeout (${cfg.matchTimeoutMin}min)`);
        ws.close();
      }, cfg.matchTimeoutMin * 60 * 1000);
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.method !== METHOD_WATCH_ATTRIBUTE_MAPS_RESULT) return;

      const result = msg.params;
      const ups = result?.watch_attribute_maps_results;
      if (!Array.isArray(ups)) return;

      // Convert to compact flat-array format: [[mid, [attrId,val,...]], ...]
      const frame = [];
      for (const up of ups) {
        const mid = up.attribute_map_id;
        const flat = attrsToFlat(up.attributes);
        if (flat.length > 0) frame.push([mid, flat]);
      }
      if (frame.length > 0) frames.push(frame);

      if (Date.now() > deadline && frames.length > 100) {
        ws.close();
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      resolve(frames);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (frames.length > 0) resolve(frames);
      else reject(err);
    });
  });
}

function splitMatches(frames) {
  const matches = [];
  let cur = null;
  let lastGt = 0;
  const KEYFRAME_EVERY = 150;

  for (const frame of frames) {
    // Get game time from global map (mid=1)
    const global = frame.find(f => f[0] === 1);
    const gt = global ? attrsGet(global[1], G_CUR_GAME_TIME, lastGt) : lastGt;

    // Match boundary: gt drops significantly
    const isNew = !cur || (gt < lastGt - 1000 && cur.frames.length > 10);

    if (isNew) {
      if (cur && cur.frames.length > 0) {
        matches.push(cur);
      }
      cur = { frames: [], durMs: 0, gtMs: 0, startGt: gt };
      lastGt = gt;
    }

    if (!cur) {
      cur = { frames: [], durMs: 0, gtMs: 0, startGt: gt };
    }

    // Convert to compact-delta format
    const frameCount = cur.frames.length + 1;
    const isKeyframe = frameCount === 1 || frameCount % KEYFRAME_EVERY === 0;

    const compactFrame = [];
    for (const [mid, flat] of frame) {
      if (isKeyframe) {
        compactFrame.push([mid, flat, 0]); // 0 = keyframe
      } else {
        const prevFrame = cur.frames.length > 0
          ? cur.frames[cur.frames.length - 1].find(f => f[0] === mid)
          : null;
        const prevFlat = prevFrame ? prevFrame[1] : null;
        const diff = attrsDiff(prevFlat, flat);
        if (diff) compactFrame.push([mid, diff, 1]); // 1 = delta
      }
    }

    if (compactFrame.length > 0) {
      cur.frames.push(compactFrame);
    }

    cur.durMs = frame.length;
    cur.gtMs = gt - cur.startGt;
    lastGt = gt;
  }

  if (cur && cur.frames.length > 0) matches.push(cur);
  return matches;
}

main().catch(err => { console.error(err); process.exit(1); });
